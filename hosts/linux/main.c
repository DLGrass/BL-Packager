// bl-player (Linux) — minimal GTK3 + WebKit2GTK host for a BL-Packager HTML.
//
// The payload and its metadata are linked into the binary as .rodata blobs (the
// build script generates the .S with .incbin), so the result really is one file:
//
//     bl-player = host code + gzip(packed html) + app.meta
//
// Nothing is fetched at runtime and nothing is written to disk. Gzip is inflated
// with the system zlib, which every distribution already has — unlike WebView2,
// WebKitGTK's host can do that itself, so there is no JavaScript bootstrap here
// (README 6.2 explains the Windows exception).
//
// The page is served from http://127.0.0.1:<random>/<random token>/ rather than a
// custom URI scheme: the packed project is a real web app (blob: workers for the
// compiler, AudioWorklets, WebGL, localStorage) and a loopback origin is the one
// origin that behaves identically to a browser's.
//
// Build: hosts/linux/build.sh (gcc, webkit2gtk-4.1 >= 2.40, -lz -lpthread).

#include <gtk/gtk.h>
#include <gdk/gdkkeysyms.h>
#include <webkit2/webkit2.h>
#include <jsc/jsc.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <zlib.h>

// ------------------------------------------------------- embedded resources
// Defined by the generated blob.S; see hosts/linux/build.sh.
extern const unsigned char payload_start[];
extern const unsigned char payload_end[];
extern const unsigned char meta_start[];
extern const unsigned char meta_end[];

// ------------------------------------------------------------------- state

static char g_title[512] = "Packaged project";
static char g_window_mode[32] = "window";
static char *g_probe_path = NULL;
static int g_width = 640;
static int g_height = 480;
static gboolean g_payload_gzip = TRUE;
static gboolean g_allow_devtools = TRUE;

static unsigned char *g_html = NULL;
static gsize g_html_len = 0;

static GtkWindow *g_window = NULL;
static WebKitWebView *g_web = NULL;
static gboolean g_fullscreen = FALSE;

static int g_listen_fd = -1;
static char g_token[33];

static int g_probe_tries = 0;
static gboolean g_probe_done = FALSE;
static int g_exit_code = 0;

// ------------------------------------------------------------------ helpers

static void trim_line(char *line) {
    size_t n = strlen(line);
    while (n > 0 && (line[n - 1] == '\r' || line[n - 1] == ' ' || line[n - 1] == '\t')) {
        line[--n] = '\0';
    }
}

/** `key=value` per line, UTF-8 — the same file format the exe host reads. */
static void parse_meta(void) {
    const size_t len = (size_t)(meta_end - meta_start);
    char *text = g_strndup((const char *)meta_start, (gsize)len);
    char *save = NULL;
    for (char *line = strtok_r(text, "\n", &save); line != NULL;
         line = strtok_r(NULL, "\n", &save)) {
        trim_line(line);
        char *eq = strchr(line, '=');
        if (eq == NULL) continue;
        *eq = '\0';
        const char *key = line;
        const char *value = eq + 1;
        if (strcmp(key, "title") == 0) {
            g_strlcpy(g_title, value, sizeof g_title);
        } else if (strcmp(key, "width") == 0) {
            g_width = MAX(160, atoi(value));
        } else if (strcmp(key, "height") == 0) {
            g_height = MAX(120, atoi(value));
        } else if (strcmp(key, "gzip") == 0) {
            g_payload_gzip = strcmp(value, "0") != 0;
        } else if (strcmp(key, "devtools") == 0) {
            g_allow_devtools = strcmp(value, "0") != 0;
        } else if (strcmp(key, "window") == 0) {
            g_strlcpy(g_window_mode, value, sizeof g_window_mode);
        } else if (strcmp(key, "probe") == 0) {
            g_free(g_probe_path);
            g_probe_path = g_strdup(value);
        }
    }
    g_free(text);
}

/** gzip (RFC 1952) -> malloc'd buffer. @returns length, or 0 on bad input. */
static gsize gunzip(const unsigned char *input, gsize input_len, unsigned char **output) {
    *output = NULL;
    if (input_len == 0) return 0;

    z_stream strm;
    memset(&strm, 0, sizeof strm);
    // 15 window bits + 16 = gzip framing.
    if (inflateInit2(&strm, 15 + 16) != Z_OK) return 0;

    gsize capacity = input_len * 3 + (1 << 16);
    unsigned char *buffer = g_malloc(capacity);
    strm.next_in = (Bytef *)input;
    strm.avail_in = (uInt)input_len;

    int status = Z_OK;
    while (status != Z_STREAM_END) {
        if (strm.total_out >= capacity) {
            capacity = capacity * 2;
            buffer = g_realloc(buffer, capacity);
        }
        strm.next_out = buffer + strm.total_out;
        strm.avail_out = (uInt)(capacity - strm.total_out);
        status = inflate(&strm, Z_NO_FLUSH);
        if (status != Z_OK && status != Z_STREAM_END) {
            inflateEnd(&strm);
            g_free(buffer);
            return 0;
        }
    }
    const gsize produced = (gsize)strm.total_out;
    inflateEnd(&strm);
    *output = buffer;
    return produced;
}

// ------------------------------------------------------------------- server

static void send_all(int fd, const void *buffer, size_t length) {
    const char *cursor = (const char *)buffer;
    while (length > 0) {
        const ssize_t sent = send(fd, cursor, length, 0);
        if (sent <= 0) return;
        cursor += sent;
        length -= (size_t)sent;
    }
}

static void handle_connection(int fd) {
    char head[8192];
    size_t used = 0;
    head[0] = '\0';
    while (used < sizeof head - 1) {
        const ssize_t got = recv(fd, head + used, sizeof head - 1 - used, 0);
        if (got <= 0) break;
        used += (size_t)got;
        head[used] = '\0';
        if (strstr(head, "\r\n\r\n") != NULL) break;
    }

    char method[8] = {0};
    char target[2048] = {0};
    const gboolean parsed = sscanf(head, "%7s %2047s", method, target) == 2;

    char expected[64];
    snprintf(expected, sizeof expected, "/%s/index.html", g_token);

    if (parsed && strcmp(method, "GET") == 0 && strcmp(target, expected) == 0 && g_html != NULL) {
        char header[256];
        const int length = snprintf(header, sizeof header,
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/html; charset=utf-8\r\n"
            "Content-Length: %lu\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n\r\n",
            (unsigned long)g_html_len);
        send_all(fd, header, (size_t)length);
        send_all(fd, g_html, g_html_len);
    } else {
        static const char kNotFound[] =
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        send_all(fd, kNotFound, sizeof kNotFound - 1);
    }
}

static void *connection_thread(void *arg) {
    const int fd = (int)(intptr_t)arg;
    handle_connection(fd);
    close(fd);
    return NULL;
}

static void *accept_loop(void *unused) {
    (void)unused;
    for (;;) {
        const int fd = accept(g_listen_fd, NULL, NULL);
        if (fd < 0) break;
        // One thread per connection: WebView may open a second socket for a
        // favicon or a preconnect, and a blocking single-threaded server would
        // stall the document on it.
        pthread_t thread;
        if (pthread_create(&thread, NULL, connection_thread, (void *)(intptr_t)fd) == 0) {
            pthread_detach(thread);
        } else {
            handle_connection(fd);
            close(fd);
        }
    }
    return NULL;
}

/** Bind 127.0.0.1 on an ephemeral port. @returns the port, or -1. */
static int server_start(void) {
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0) { close(fd); return -1; }
    if (listen(fd, 16) != 0) { close(fd); return -1; }

    socklen_t size = sizeof addr;
    if (getsockname(fd, (struct sockaddr *)&addr, &size) != 0) { close(fd); return -1; }

    unsigned char raw[16];
    // /dev/urandom when it is there; g_random_int() is seeded from it otherwise.
    // This token only has to stop another local process from reading the page.
    gboolean have_entropy = FALSE;
    FILE *urandom = fopen("/dev/urandom", "rb");
    if (urandom != NULL) {
        have_entropy = fread(raw, 1, sizeof raw, urandom) == sizeof raw;
        fclose(urandom);
    }
    if (!have_entropy) {
        for (size_t i = 0; i < sizeof raw; i++) raw[i] = (unsigned char)(g_random_int() & 0xff);
    }
    for (size_t i = 0; i < sizeof raw; i++) snprintf(g_token + i * 2, 3, "%02x", raw[i]);

    g_listen_fd = fd;
    pthread_t thread;
    if (pthread_create(&thread, NULL, accept_loop, NULL) == 0) pthread_detach(thread);
    return ntohs(addr.sin_port);
}

// -------------------------------------------------------------------- probe

/**
 * Smoke test support: read the live VM back out through JavaScript, then quit.
 * `targets`, not `window.vm`, is the readiness signal — the VM object exists
 * before loadProject() has built the stage, so an early poll reports targets:0.
 */
static const char *PROBE_JS =
    "JSON.stringify({"
    "title:document.title,"
    "vm:!!window.vm,"
    "targets:(window.vm&&window.vm.runtime&&window.vm.runtime.targets)"
    "?window.vm.runtime.targets.length:-1,"
    "assets:(window.vm&&window.vm.runtime&&window.vm.runtime.targets)"
    "?window.vm.runtime.targets.reduce(function(n,t){"
    "return n+t.sprite.costumes.length+t.sprite.sounds.length},0):-1,"
    "canvas:document.querySelectorAll('canvas').length,"
    "ms:Math.round(performance.now()),"
    "error:(document.getElementById('error')&&!document.getElementById('error').hidden)"
    "?document.getElementById('error-message').textContent:null"
    "})";

/** `"targets":12` -> 12. The probe result is a JSON string, not an object. */
static int extract_int(const char *text, const char *key) {
    char needle[64];
    snprintf(needle, sizeof needle, "\"%s\":", key);
    const char *at = strstr(text, needle);
    if (at == NULL) return -1;
    at += strlen(needle);
    int value = 0;
    gboolean any = FALSE;
    for (; *at != '\0'; at++) {
        if (*at >= '0' && *at <= '9') {
            value = value * 10 + (*at - '0');
            any = TRUE;
        } else if (any || *at != ' ') {
            break;
        }
    }
    return any ? value : -1;
}

static void finish_probe(const char *json) {
    if (g_probe_done) return;
    g_probe_done = TRUE;
    if (g_probe_path != NULL) {
        FILE *file = fopen(g_probe_path, "wb");
        if (file != NULL) {
            fputs(json, file);
            fclose(file);
        }
    }
    gtk_main_quit();
}

static void on_probe_evaluated(GObject *source, GAsyncResult *result, gpointer data) {
    (void)data;
    GError *error = NULL;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(
        WEBKIT_WEB_VIEW(source), result, &error);
    char *text = value != NULL ? jsc_value_to_string(value) : NULL;
    const int targets = text != NULL ? extract_int(text, "targets") : -1;

    if (targets > 0) {
        finish_probe(text);
    } else if (g_probe_tries >= 120) {
        g_exit_code = 2;
        char *json = g_strdup_printf("{\"error\":\"%s\"}",
            text != NULL ? "targets never appeared" : "evaluateJavaScript failed");
        finish_probe(json);
        g_free(json);
    }
    g_free(text);
    if (value != NULL) g_object_unref(value);
    if (error != NULL) g_error_free(error);
}

static gboolean probe_tick(gpointer data) {
    (void)data;
    if (g_probe_done) return G_SOURCE_REMOVE;
    g_probe_tries++;
    webkit_web_view_evaluate_javascript(g_web, PROBE_JS, -1, NULL, NULL,
        WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, NULL, on_probe_evaluated, NULL);
    return G_SOURCE_CONTINUE;
}

// ------------------------------------------------------------------- window

/**
 * Escape leaves fullscreen and nothing else, and only when the window really is
 * fullscreen — otherwise the page keeps its own Escape (pointer lock, dialogs).
 */
static gboolean on_key_press(GtkWidget *widget, GdkEventKey *event, gpointer data) {
    (void)widget;
    (void)data;
    if (event->keyval == GDK_KEY_F11) {
        // Set the flag here as well as in on_window_state: some WMs deliver the
        // state event late (or not at all), and a stale flag makes F11 a no-op.
        if (g_fullscreen) {
            gtk_window_unfullscreen(g_window);
            g_fullscreen = FALSE;
        } else {
            gtk_window_fullscreen(g_window);
            g_fullscreen = TRUE;
        }
        return TRUE;
    }
    if (event->keyval == GDK_KEY_Escape && g_fullscreen) {
        gtk_window_unfullscreen(g_window);
        g_fullscreen = FALSE;
        return TRUE;
    }
    if (event->keyval == GDK_KEY_F12 && g_allow_devtools) {
        // WebKitGTK ships a real inspector window; unlike macOS there is a public
        // call for it, so F12 works here.
        webkit_web_inspector_show(webkit_web_view_get_inspector(g_web));
        return TRUE;
    }
    return FALSE;
}

/** Track fullscreen toggled from the window manager/title bar, not just by us. */
static gboolean on_window_state(GtkWidget *widget, GdkEventWindowState *event, gpointer data) {
    (void)widget;
    (void)data;
    if ((event->changed_mask & GDK_WINDOW_STATE_FULLSCREEN) != 0) {
        g_fullscreen = (event->new_window_state & GDK_WINDOW_STATE_FULLSCREEN) != 0;
    }
    return FALSE;
}

int main(int argc, char **argv) {
    parse_meta();

    const gsize payload_len = (gsize)(payload_end - payload_start);
    if (payload_len == 0) {
        fprintf(stderr, "bl-player: embedded payload is empty; rebuild with hosts/linux/build.sh\n");
        return 6;
    }
    if (g_payload_gzip) {
        g_html_len = gunzip(payload_start, payload_len, &g_html);
        if (g_html_len == 0) {
            fprintf(stderr, "bl-player: embedded payload could not be decompressed\n");
            return 6;
        }
    } else {
        // Copied rather than aliased: the rodata blob stays valid, but one
        // ownership rule for g_html keeps the cleanup at the bottom honest.
        g_html = g_malloc(payload_len);
        memcpy(g_html, payload_start, payload_len);
        g_html_len = payload_len;
    }

    const int port = server_start();
    if (port <= 0) {
        fprintf(stderr, "bl-player: could not open the loopback port the page is served from\n");
        return 7;
    }

    gtk_init(&argc, &argv);
    g_set_application_name(g_title);

    g_window = GTK_WINDOW(gtk_window_new(GTK_WINDOW_TOPLEVEL));
    gtk_window_set_title(g_window, g_title);
    gtk_window_set_default_size(g_window, g_width, g_height);
    gtk_window_set_position(g_window, GTK_WIN_POS_CENTER);

    g_web = WEBKIT_WEB_VIEW(webkit_web_view_new());
    WebKitSettings *settings = webkit_web_view_get_settings(g_web);
    webkit_settings_set_enable_developer_extras(settings, g_allow_devtools);
    webkit_settings_set_enable_webaudio(settings, TRUE);
    webkit_settings_set_enable_webgl(settings, TRUE);
    webkit_settings_set_javascript_can_open_windows_automatically(settings, FALSE);

    gtk_container_add(GTK_CONTAINER(g_window), GTK_WIDGET(g_web));
    g_signal_connect(g_window, "destroy", G_CALLBACK(gtk_main_quit), NULL);
    g_signal_connect(g_window, "key-press-event", G_CALLBACK(on_key_press), NULL);
    g_signal_connect(g_window, "window-state-event", G_CALLBACK(on_window_state), NULL);

    char *url = g_strdup_printf("http://127.0.0.1:%d/%s/index.html", port, g_token);
    webkit_web_view_load_uri(g_web, url);
    g_free(url);

    gtk_widget_show_all(GTK_WIDGET(g_window));
    if (g_strcmp0(g_window_mode, "maximize") == 0) {
        gtk_window_maximize(g_window);
    } else if (g_strcmp0(g_window_mode, "fullscreen") == 0) {
        gtk_window_fullscreen(g_window);
        g_fullscreen = TRUE;
    }

    if (g_probe_path != NULL) g_timeout_add(500, probe_tick, NULL);

    gtk_main();

    if (g_probe_path != NULL && !g_probe_done) g_exit_code = 2;
    // g_html is deliberately not freed: the server thread may still be writing
    // it to a socket, and the process is about to exit anyway.
    g_free(g_probe_path);
    return g_exit_code;
}
