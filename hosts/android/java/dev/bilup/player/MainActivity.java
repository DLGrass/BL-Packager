package dev.bilup.player;

// bl-player (Android) — minimal WebView host for a BL-Packager single-file HTML.
//
// The payload is the same artifact src/pack.js produces: one self-contained HTML
// with the runtime, the project and every asset inlined. The APK carries it as
// assets/app.html.gz, this class inflates it once (GZIPInputStream, no third-party
// code) and serves it from a loopback HTTP server.
//
// Why a server instead of loadDataWithBaseURL() or file://:
//
//   * loadDataWithBaseURL() hands the whole document to the renderer in one IPC
//     payload. Works for a demo, and for a 15 MB pack it is exactly the kind of
//     thing that fails on one device and not another.
//   * file:// gives an opaque origin: blob: workers (the compiler), AudioWorklets
//     and localStorage all stop working or behave differently.
//   * http://127.0.0.1:<port> is a normal, potentially-trustworthy origin, so the
//     page sees the same environment a browser gives it. The socket never leaves
//     the device and the 128-bit path token keeps other apps from reading it.
//
// No androidx: this file is compiled against android.jar alone, which is what lets
// hosts/android/build.sh be aapt2 + javac + d8 + apksigner instead of a Gradle
// project with a dependency graph behind it.

import android.app.Activity;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.zip.GZIPInputStream;

import org.json.JSONException;
import org.json.JSONTokener;

public final class MainActivity extends Activity {
    private static final String TAG = "bl-player";

    /** Readiness must be judged by targets, not by window.vm: the VM object
     *  exists before loadProject() has built the stage. */
    private static final String PROBE_JS =
        "JSON.stringify({"
        + "title:document.title,"
        + "vm:!!window.vm,"
        + "targets:(window.vm&&window.vm.runtime&&window.vm.runtime.targets)"
        + "?window.vm.runtime.targets.length:-1,"
        + "assets:(window.vm&&window.vm.runtime&&window.vm.runtime.targets)"
        + "?window.vm.runtime.targets.reduce(function(n,t){"
        + "return n+t.sprite.costumes.length+t.sprite.sounds.length},0):-1,"
        + "canvas:document.querySelectorAll('canvas').length,"
        + "ms:Math.round(performance.now()),"
        + "error:(document.getElementById('error')&&!document.getElementById('error').hidden)"
        + "?document.getElementById('error-message').textContent:null"
        + "})";

    private static final long PROBE_INTERVAL_MS = 500;
    private static final int PROBE_MAX_TRIES = 120;

    private WebView web;
    private PayloadServer server;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private String probePath;
    private int probeTries;
    private boolean probeDone;

    // ------------------------------------------------------------------ life

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        Meta meta = Meta.read(getAssets());
        probePath = meta.probe;

        // A player should not sleep mid-game, and the screen is the whole app.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);

        byte[] html;
        try {
            html = Payload.load(getAssets(), meta.gzip);
        } catch (IOException error) {
            Log.e(TAG, "cannot read the payload from assets", error);
            showError("Cannot read the packaged project: " + error.getMessage());
            return;
        }

        try {
            server = new PayloadServer(html);
        } catch (IOException error) {
            Log.e(TAG, "cannot start the loopback server", error);
            showError("Cannot start the player: " + error.getMessage());
            return;
        }
        server.start();

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Scratch starts playing on its own (autoplay, green flag on start). A
        // gesture requirement would silently mute every project.
        settings.setMediaPlaybackRequiresUserGesture(false);
        // The page is self-contained; letting it read files would be a hole with
        // nothing on the other side of it.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        if (meta.devtools) WebView.setWebContentsDebuggingEnabled(true);

        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        applyImmersive();

        web.loadUrl("http://127.0.0.1:" + server.getPort() + "/" + server.getToken()
                + "/index.html");

        if (probePath != null) handler.postDelayed(probeTick, PROBE_INTERVAL_MS);
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) {
            web.destroy();
            web = null;
        }
        if (server != null) {
            server.close();
            server = null;
        }
        super.onDestroy();
    }

    /**
     * Immersive, sticky: swiping from an edge reveals the bars briefly and they
     * slide away again. The legacy flags are deprecated since API 30 but still
     * honoured, and unlike WindowInsetsController they do not need a version-split
     * code path (a missing class in a method that is merely *verified* is how
     * Android apps crash on old devices).
     */
    private void applyImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void showError(String message) {
        android.widget.TextView view = new android.widget.TextView(this);
        view.setText(message);
        view.setTextColor(Color.WHITE);
        view.setBackgroundColor(Color.BLACK);
        view.setPadding(48, 96, 48, 48);
        setContentView(view);
    }

    // ----------------------------------------------------------------- probe

    private final Runnable probeTick = new Runnable() {
        @Override
        public void run() {
            if (web == null || probeDone) return;
            probeTries++;
            web.evaluateJavascript(PROBE_JS, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    // evaluateJavascript returns the value JSON-encoded, so a JS
                    // string comes back as a quoted literal. JSONTokener is part
                    // of the framework, which is less code than unescaping by
                    // hand and does not get it wrong on quotes inside the JSON.
                    String json = decode(value);
                    int targets = json == null ? -1 : extractInt(json, "targets");
                    if (targets > 0 || probeTries >= PROBE_MAX_TRIES) {
                        writeProbe(json != null ? json
                                : "{\"error\":\"evaluateJavascript returned null\"}");
                        return;
                    }
                    handler.postDelayed(probeTick, PROBE_INTERVAL_MS);
                }
            });
        }
    };

    private void writeProbe(String json) {
        probeDone = true;
        try {
            FileOutputStream out = new FileOutputStream(probePath);
            out.write(json.getBytes("UTF-8"));
            out.close();
        } catch (IOException error) {
            Log.e(TAG, "cannot write the probe file", error);
        }
        finish();
    }

    /** The JS string inside the JSON literal evaluateJavascript hands back. */
    private static String decode(String literal) {
        if (literal == null) return null;
        try {
            Object value = new JSONTokener(literal).nextValue();
            return value instanceof String ? (String) value : null;
        } catch (JSONException error) {
            return null;
        }
    }

    /** `"targets":12` -> 12. */
    private static int extractInt(String text, String key) {
        int at = text.indexOf("\"" + key + "\":");
        if (at < 0) return -1;
        int value = 0;
        boolean any = false;
        for (int i = at + key.length() + 3; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c >= '0' && c <= '9') {
                value = value * 10 + (c - '0');
                any = true;
            } else if (any || c != ' ') {
                break;
            }
        }
        return any ? value : -1;
    }

    // ------------------------------------------------------------------ meta

    /** `key=value` per line, UTF-8 — the same file format the exe host reads. */
    private static final class Meta {
        boolean gzip = true;
        boolean devtools = true;
        String probe = null;

        static Meta read(AssetManager assets) {
            Meta meta = new Meta();
            String text = Payload.readText(assets, "app.meta");
            if (text == null) return meta;
            for (String raw : text.split("\n")) {
                String line = raw.trim();
                int eq = line.indexOf('=');
                if (eq <= 0) continue;
                String key = line.substring(0, eq);
                String value = line.substring(eq + 1);
                if ("gzip".equals(key)) meta.gzip = !"0".equals(value);
                else if ("devtools".equals(key)) meta.devtools = !"0".equals(value);
                else if ("probe".equals(key)) meta.probe = value;
            }
            return meta;
        }
    }

    // -------------------------------------------------------------- payload

    private static final class Payload {
        static String readText(AssetManager assets, String name) {
            try {
                InputStream in = assets.open(name);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                in.close();
                return out.toString("UTF-8");
            } catch (IOException error) {
                return null;
            }
        }

        /** The whole HTML in memory: it is written to the socket once, and
         *  inflating a 15 MB gzip costs a couple of hundred milliseconds. */
        static byte[] load(AssetManager assets, boolean gzip) throws IOException {
            InputStream in = assets.open("app.html.gz");
            if (gzip) in = new GZIPInputStream(in, 1 << 16);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                return out.toByteArray();
            } finally {
                in.close();
            }
        }
    }

    // --------------------------------------------------------------- server

    /**
     * One payload, one port, one random path. Loopback only: a socket on 0.0.0.0
     * would expose the page to the network and need a firewall story.
     */
    private static final class PayloadServer {
        private final byte[] body;
        private final String token;
        private final ServerSocket socket;
        private volatile boolean open = true;

        PayloadServer(byte[] body) throws IOException {
            this.body = body;
            // Port 0 = let the kernel pick a free one; iOS-style fixed ports are
            // how players collide with whatever else is running.
            this.socket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            byte[] raw = new byte[16];
            new SecureRandom().nextBytes(raw);
            StringBuilder hex = new StringBuilder(32);
            for (byte value : raw) hex.append(String.format("%02x", value));
            this.token = hex.toString();
        }

        int getPort() {
            return socket.getLocalPort();
        }

        String getToken() {
            return token;
        }

        void start() {
            Thread thread = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (open) {
                        try {
                            final Socket client = socket.accept();
                            Thread worker = new Thread(new Runnable() {
                                @Override
                                public void run() {
                                    handle(client);
                                }
                            }, "bl-payload-conn");
                            worker.setDaemon(true);
                            worker.start();
                        } catch (IOException error) {
                            break;
                        }
                    }
                }
            }, "bl-payload-server");
            thread.setDaemon(true);
            thread.start();
        }

        void close() {
            open = false;
            try {
                socket.close();
            } catch (IOException ignored) {
                // Closing an already-closed listener is the normal shutdown path.
            }
        }

        private void handle(Socket client) {
            try {
                InputStream in = client.getInputStream();
                ByteArrayOutputStream head = new ByteArrayOutputStream(512);
                int value;
                while ((value = in.read()) >= 0 && head.size() < 8192) {
                    head.write(value);
                    // The head ends at the first empty line. Checking on '\n'
                    // rather than counting bytes keeps this a ten-line reader;
                    // a GET has no body, so nothing after it is of interest.
                    if (value == '\n') {
                        String soFar = head.toString("US-ASCII");
                        if (soFar.endsWith("\r\n\r\n") || soFar.endsWith("\n\n")) break;
                    }
                }
                String requestLine = head.toString("US-ASCII").split("\r\n")[0];
                String[] parts = requestLine.split(" ");
                boolean ok = parts.length >= 2 && "GET".equals(parts[0])
                        && ("/" + token + "/index.html").equals(parts[1]);

                OutputStream out = new BufferedOutputStream(client.getOutputStream(), 1 << 16);
                if (ok) {
                    out.write(("HTTP/1.1 200 OK\r\n"
                            + "Content-Type: text/html; charset=utf-8\r\n"
                            + "Content-Length: " + body.length + "\r\n"
                            + "Cache-Control: no-store\r\n"
                            + "Connection: close\r\n\r\n").getBytes("US-ASCII"));
                    out.write(body);
                } else {
                    out.write(("HTTP/1.1 404 Not Found\r\n"
                            + "Content-Length: 0\r\n"
                            + "Connection: close\r\n\r\n").getBytes("US-ASCII"));
                }
                out.flush();
            } catch (IOException error) {
                Log.w(TAG, "payload connection failed", error);
            } finally {
                try {
                    client.close();
                } catch (IOException ignored) {
                    // Nothing left to do with a socket that is already gone.
                }
            }
        }
    }
}
