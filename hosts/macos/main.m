// bl-player (macOS) — minimal WKWebView host for a BL-Packager single-file HTML.
//
// The payload is the same artifact `src/pack.js` produces: one self-contained
// HTML with the runtime, the project and every asset inlined. This host adds a
// window and nothing else, so the page a Mac runs is byte-identical to the page
// a browser runs.
//
// Two decisions worth writing down:
//
//   * The payload is served over http://127.0.0.1:<random>/<random token>/ rather
//     than through WKURLSchemeHandler. A custom scheme is fine for the top-level
//     document but is not a "potentially trustworthy" origin, and the packed page
//     is a real web app: blob: workers for the compiler, AudioWorklets, WebGL,
//     localStorage. A loopback origin behaves exactly like a browser's, costs one
//     socket that never leaves the machine, and the token keeps other local
//     processes from reading the page (see ServerStart).
//
//   * The host inflates the gzip payload itself (zlib is part of the SDK). Its
//     Windows sibling cannot: WebView2 does not run HTTP content decoding on
//     responses injected through WebResourceRequested, which is why that host
//     ships a JavaScript bootstrap instead (README 6.2). Here it is ~20 lines of
//     C and no extra bytes at runtime.
//
// Build: hosts/macos/build.sh (clang, -fobjc-arc, -framework Cocoa/WebKit -lz).

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <zlib.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

// ------------------------------------------------------------------- state

static NSString *g_title = @"Packaged project";
static NSString *g_windowMode = @"window";
static NSString *g_probePath = nil;
static int g_width = 640;
static int g_height = 480;
static BOOL g_payloadGzip = YES;
static BOOL g_allowDevTools = YES;

static NSData *g_html = nil;
static NSWindow *g_window = nil;
static WKWebView *g_web = nil;

static int g_listenFd = -1;
static char g_token[33];

// Virtual key codes; the names are not in any header.
enum { kKeyEscape = 53, kKeyF11 = 103 };

// ------------------------------------------------------------------ helpers

/** gzip (RFC 1952) -> NSData, using the SDK's zlib. Returns nil on bad input. */
static NSData *Gunzip(NSData *input) {
    if (input.length == 0) return nil;
    z_stream strm;
    memset(&strm, 0, sizeof strm);
    // 15 window bits + 16 = gzip framing.
    if (inflateInit2(&strm, 15 + 16) != Z_OK) return nil;

    NSMutableData *out = [NSMutableData dataWithLength:input.length * 3 + (1 << 16)];
    strm.next_in = (Bytef *)input.bytes;
    strm.avail_in = (uInt)input.length;

    int status = Z_OK;
    while (status != Z_STREAM_END) {
        if (strm.total_out >= out.length) [out increaseLengthBy:out.length / 2 + (1 << 16)];
        strm.next_out = (Bytef *)out.mutableBytes + strm.total_out;
        strm.avail_out = (uInt)(out.length - strm.total_out);
        status = inflate(&strm, Z_NO_FLUSH);
        if (status != Z_OK && status != Z_STREAM_END) {
            inflateEnd(&strm);
            return nil;
        }
    }
    const NSUInteger produced = strm.total_out;
    inflateEnd(&strm);
    [out setLength:produced];
    return out;
}

static NSString *ResourcePath(NSString *name) {
    NSString *dir = [[NSBundle mainBundle] resourcePath];
    if (dir == nil) dir = [[[NSBundle mainBundle] bundlePath]
        stringByAppendingPathComponent:@"Contents/Resources"];
    return [dir stringByAppendingPathComponent:name];
}

/** `key=value` per line, UTF-8 — the same file format the exe host reads. */
static void ParseMeta(NSData *data) {
    if (data == nil) return;
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (text == nil) return;
    for (NSString *line in [text componentsSeparatedByCharactersInSet:
            [NSCharacterSet newlineCharacterSet]]) {
        const NSRange eq = [line rangeOfString:@"="];
        if (eq.location == NSNotFound) continue;
        NSString *key = [line substringToIndex:eq.location];
        NSString *value = [line substringFromIndex:eq.location + 1];
        if ([key isEqualToString:@"title"]) g_title = value;
        else if ([key isEqualToString:@"width"]) g_width = MAX(160, value.intValue);
        else if ([key isEqualToString:@"height"]) g_height = MAX(120, value.intValue);
        else if ([key isEqualToString:@"gzip"]) g_payloadGzip = ![value isEqualToString:@"0"];
        else if ([key isEqualToString:@"devtools"]) g_allowDevTools = ![value isEqualToString:@"0"];
        else if ([key isEqualToString:@"window"]) g_windowMode = value;
        else if ([key isEqualToString:@"probe"]) g_probePath = value;
    }
}

/** A modal alert would hang an automated run; probe mode records and exits. */
static void FailFast(NSString *message, int code) {
    if (g_probePath != nil) {
        NSString *safe = [message stringByReplacingOccurrencesOfString:@"\"" withString:@"'"];
        NSString *json = [NSString stringWithFormat:@"{\"error\":\"%@\"}", safe];
        [json writeToFile:g_probePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
        exit(code);
    }
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = g_title;
    alert.informativeText = message;
    alert.alertStyle = NSAlertStyleCritical;
    [alert runModal];
    exit(code);
}

// ------------------------------------------------------------------- server

static void SendAll(int fd, const void *buffer, size_t length) {
    const char *cursor = (const char *)buffer;
    while (length > 0) {
        const ssize_t sent = send(fd, cursor, length, 0);
        if (sent <= 0) return;
        cursor += sent;
        length -= (size_t)sent;
    }
}

static void HandleConnection(int fd) {
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
    const BOOL parsed = sscanf(head, "%7s %2047s", method, target) == 2;

    char expected[64];
    snprintf(expected, sizeof expected, "/%s/index.html", g_token);

    if (parsed && strcmp(method, "GET") == 0 && strcmp(target, expected) == 0 &&
        g_html != nil) {
        char header[256];
        const int length = snprintf(header, sizeof header,
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/html; charset=utf-8\r\n"
            "Content-Length: %lu\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n\r\n",
            (unsigned long)g_html.length);
        SendAll(fd, header, (size_t)length);
        SendAll(fd, g_html.bytes, g_html.length);
    } else {
        static const char kNotFound[] =
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        SendAll(fd, kNotFound, sizeof kNotFound - 1);
    }
}

static void *AcceptLoop(void *unused) {
    (void)unused;
    for (;;) {
        const int fd = accept(g_listenFd, NULL, NULL);
        if (fd < 0) break;
        HandleConnection(fd);
        close(fd);
    }
    return NULL;
}

/**
 * Bind 127.0.0.1 on an ephemeral port. Loopback-only on purpose: a listener on
 * 0.0.0.0 would trigger the macOS firewall prompt and expose the page to the
 * network, neither of which a player needs.
 *
 * @returns the port, or -1.
 */
static int ServerStart(void) {
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
    arc4random_buf(raw, sizeof raw);
    for (size_t i = 0; i < sizeof raw; i++) snprintf(g_token + i * 2, 3, "%02x", raw[i]);

    g_listenFd = fd;
    pthread_t thread;
    if (pthread_create(&thread, NULL, AcceptLoop, NULL) == 0) pthread_detach(thread);
    return ntohs(addr.sin_port);
}

// ------------------------------------------------------------------- window

static BOOL IsFullscreen(void) {
    return g_window != nil &&
        (g_window.styleMask & NSWindowStyleMaskFullScreen) != 0;
}

/**
 * Escape leaves fullscreen and nothing else — the same rule the Windows host
 * documents. Only when the window is actually fullscreen, so the page keeps its
 * own Escape (pointer lock, dialogs) in every other case.
 *
 * F11 toggles. There is no F12: WKWebView has no public "open the inspector"
 * call, only `inspectable` (set at startup when devtools are on), which is what
 * lets Safari's Develop menu attach to this app.
 */
static BOOL HandleKey(NSEvent *event) {
    switch (event.keyCode) {
        case kKeyF11:
            [g_window toggleFullScreen:nil];
            return YES;
        case kKeyEscape:
            if (!IsFullscreen()) return NO;
            [g_window toggleFullScreen:nil];
            return YES;
        default:
            return NO;
    }
}

// -------------------------------------------------------------------- probe

/**
 * Smoke test support. Reads the live VM back out through JavaScript and exits,
 * which is how "it compiled" becomes "it runs" (same contract as the exe's
 * --probe). Targets, not window.vm, is the readiness signal: the VM object exists
 * before loadProject() has built the stage.
 */
static const char *kProbeScript =
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

/** `"targets":12` -> 12. The probe result is a JSON string, not a dictionary. */
static int ExtractInt(NSString *text, NSString *key) {
    NSString *needle = [NSString stringWithFormat:@"\"%@\":", key];
    const NSRange at = [text rangeOfString:needle];
    if (at.location == NSNotFound) return -1;
    int value = 0;
    BOOL any = NO;
    for (NSUInteger i = at.location + at.length; i < text.length; i++) {
        const unichar c = [text characterAtIndex:i];
        if (c >= '0' && c <= '9') {
            value = value * 10 + (int)(c - '0');
            any = YES;
        } else if (any || c != ' ') {
            break;
        }
    }
    return any ? value : -1;
}

static void StartProbe(void) {
    __block int tries = 0;
    NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES
                                                       block:^(NSTimer *t) {
        (void)t;
        tries++;
        [g_web evaluateJavaScript:[NSString stringWithUTF8String:kProbeScript]
                completionHandler:^(id result, NSError *error) {
            NSString *json = [result isKindOfClass:[NSString class]] ? (NSString *)result : nil;
            const int targets = json != nil ? ExtractInt(json, @"targets") : -1;
            if (targets <= 0 && tries < 120) return;
            if (json == nil) {
                NSString *why = error != nil ? error.localizedDescription : @"evaluateJavaScript failed";
                json = [NSString stringWithFormat:@"{\"error\":\"%@\"}",
                    [why stringByReplacingOccurrencesOfString:@"\"" withString:@"'"]];
            }
            [json writeToFile:g_probePath atomically:YES
                     encoding:NSUTF8StringEncoding error:nil];
            exit(targets > 0 ? 0 : 2);
        }];
    }];
    (void)timer;
}

// --------------------------------------------------------------------- main

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    (void)sender;
    return YES;
}
@end

static void BuildMenu(void) {
    NSMenu *menubar = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [menubar addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:[@"Quit " stringByAppendingString:g_title]
                       action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    [menubar addItem:viewItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
    NSMenuItem *full = [[NSMenuItem alloc] initWithTitle:@"Toggle Full Screen"
                                                  action:@selector(toggleFullScreen:)
                                           keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagControl | NSEventModifierFlagCommand;
    [viewMenu addItem:full];
    viewItem.submenu = viewMenu;

    NSApp.mainMenu = menubar;
}

int main(int argc, const char *argv[]) {
    (void)argc;
    (void)argv;
    @autoreleasepool {
        // Before anything can fail: FailFast may put up an alert, and an alert
        // needs an initialized application.
        [NSApplication sharedApplication];

        NSData *meta = [NSData dataWithContentsOfFile:ResourcePath(@"app.meta")];
        ParseMeta(meta);

        NSString *payloadName = @"app.html.gz";
        NSData *payload = [NSData dataWithContentsOfFile:ResourcePath(payloadName)];
        if (payload == nil) {
            FailFast(@"Embedded payload is missing from the app bundle.", 6);
            return 1;
        }
        g_html = g_payloadGzip ? Gunzip(payload) : payload;
        if (g_html == nil) {
            FailFast(@"Embedded payload could not be decompressed.", 6);
            return 1;
        }

        const int port = ServerStart();
        if (port <= 0) {
            FailFast(@"Could not open the loopback port the page is served from.", 7);
            return 1;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        // A delegate has to outlive main's autorelease pool; a file-scope strong
        // reference is what keeps it alive, because NSApp.delegate is weak.
        static AppDelegate *delegate = nil;
        delegate = [[AppDelegate alloc] init];
        NSApp.delegate = delegate;
        BuildMenu();

        const NSRect frame = NSMakeRect(0, 0, g_width, g_height);
        const NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
            NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
        g_window = [[NSWindow alloc] initWithContentRect:frame styleMask:style
                                                 backing:NSBackingStoreBuffered defer:NO];
        if (g_window == nil) {
            FailFast(@"Could not create the window.", 8);
            return 1;
        }
        g_window.title = g_title;
        g_window.backgroundColor = [NSColor blackColor];
        [g_window center];

        WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
        g_web = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
        g_web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        // The page is a game, not a document: swiping should not navigate, and
        // text selection on the stage is noise.
        g_web.allowsBackForwardNavigationGestures = NO;
        // `inspectable` is public since 13.3; KVC keeps this compiling against
        // older SDKs and just degrades to "no inspector" there.
        if (g_allowDevTools) {
            @try { [g_web setValue:@YES forKey:@"inspectable"]; } @catch (NSException *e) {}
        }
        g_window.contentView = g_web;

        // Local monitor rather than a subclass: the shortcuts have to work no
        // matter which view is first responder (the WebView usually is).
        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                              handler:^NSEvent *(NSEvent *event) {
            return HandleKey(event) ? nil : event;
        }];

        NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%d/%s/index.html",
                         port, g_token];
        [g_web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]];

        [g_window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        // Both of these want a window that is already on screen.
        if ([g_windowMode isEqualToString:@"maximize"]) {
            [g_window zoom:nil];
        } else if ([g_windowMode isEqualToString:@"fullscreen"]) {
            [g_window toggleFullScreen:nil];
        }
        if (g_probePath != nil) StartProbe();

        [NSApp run];
    }
    return 0;
}
