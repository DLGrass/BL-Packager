// bl-player — minimal WebView2 host for a bl-packager single-file HTML.
//
// Design notes that matter for the final executable size:
//   * The whole application payload is ONE RT_RCDATA resource holding the
//     packed HTML *gzip compressed*. This process contains NO decompressor:
//     the page's own `DecompressionStream` inflates the resource (see
//     kBootstrapTemplate for why the WebView cannot be asked to do it).
//     So ~19.6 MB of runtime HTML ships from a ~15.2 MB resource, and the
//     decompression code costs zero bytes of host code.
//   * WebView2Loader is linked statically (WebView2LoaderStatic.lib) so there
//     is no sidecar DLL, and the CRT is linked statically (/MT) so there is no
//     VC++ redistributable dependency. The only external requirement is the
//     WebView2 Runtime, which ships with Windows 10 21H2+ / Windows 11.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <string>
#include <cstdlib>
#include <cwchar>

#include "WebView2.h"

#define IDR_PAYLOAD 101
#define IDR_META 102

static const wchar_t* kOriginUrl = L"https://bl.local/index.html";
static const wchar_t* kOriginPrefix = L"https://bl.local/";

static const int kProbeIntervalMs = 500;
static const int kProbeMaxTries = 60;

static HWND g_hwnd = nullptr;
static ICoreWebView2Environment* g_env = nullptr;
static ICoreWebView2Controller* g_controller = nullptr;
static ICoreWebView2* g_webview = nullptr;

static const BYTE* g_payload = nullptr;
static DWORD g_payloadLen = 0;
static bool g_payloadGzip = true;

static std::wstring g_title = L"bl-packager project";
static int g_width = 640;
static int g_height = 480;
static bool g_allowDevTools = true;
// "window" (default) | "maximize" | "fullscreen" — set by app.meta, which is
// what the packager writes when --window-mode asks for something else.
static std::wstring g_windowMode = L"window";

// Smoke-test support. When the metadata carries `probe=<path>`, the host loads
// the project, asks the live VM through ExecuteScript what it built, writes the
// answer to that path and exits. That turns "it compiled" into "it runs".
static std::wstring g_probePath;
static int g_probeTries = 0;
static bool g_probeDone = false;

// ------------------------------------------------------------------ helpers

static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring out((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n);
    return out;
}

static bool LoadRes(HINSTANCE inst, int id, const BYTE** data, DWORD* len) {
    HRSRC r = ::FindResourceW(inst, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!r) return false;
    HGLOBAL h = ::LoadResource(inst, r);
    if (!h) return false;
    *data = static_cast<const BYTE*>(::LockResource(h));
    *len = ::SizeofResource(inst, r);
    return *data != nullptr && *len > 0;
}

static void WriteUtf8File(const std::wstring& path, const std::wstring& text) {
    if (path.empty()) return;
    int n = ::WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(),
                                  nullptr, 0, nullptr, nullptr);
    if (n <= 0) return;
    std::string utf8((size_t)n, '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(),
                          &utf8[0], n, nullptr, nullptr);
    HANDLE h = ::CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                             CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    ::WriteFile(h, utf8.data(), (DWORD)utf8.size(), &written, nullptr);
    ::CloseHandle(h);
}

// In probe mode a modal dialog would hang an automated run, so record the
// failure into the probe file and exit instead of blocking.
static void FailFast(const wchar_t* message, int code) {
    if (!g_probePath.empty()) {
        WriteUtf8File(g_probePath, std::wstring(L"{\"error\":\"") + message + L"\"}");
        ::PostQuitMessage(code);
        return;
    }
    ::MessageBoxW(g_hwnd, message, g_title.c_str(), MB_ICONERROR);
}

static void ParseMeta(const BYTE* data, DWORD len) {
    std::string s(reinterpret_cast<const char*>(data), len);
    size_t pos = 0;
    while (pos < s.size()) {
        size_t end = s.find('\n', pos);
        if (end == std::string::npos) end = s.size();
        std::string line = s.substr(pos, end - pos);
        pos = end + 1;
        while (!line.empty() &&
               (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) {
            line.pop_back();
        }
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        const std::string key = line.substr(0, eq);
        const std::string val = line.substr(eq + 1);
        if (key == "title") g_title = Utf8ToWide(val);
        else if (key == "width") g_width = std::atoi(val.c_str());
        else if (key == "height") g_height = std::atoi(val.c_str());
        else if (key == "gzip") g_payloadGzip = (val != "0");
        else if (key == "devtools") g_allowDevTools = (val != "0");
        else if (key == "window") g_windowMode = Utf8ToWide(val);
        else if (key == "probe") g_probePath = Utf8ToWide(val);
    }
    if (g_width < 160) g_width = 160;
    if (g_height < 120) g_height = 120;
}

// Per-instance user data folder. WebView2 insists on a writable directory; it
// holds the HTTP cache and the GPU shader cache, which is exactly what makes
// the SECOND launch of a large project fast, so it is worth keeping.
static std::wstring UserDataFolder() {
    wchar_t buf[MAX_PATH] = {0};
    DWORD n = ::GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
    std::wstring root = (n > 0 && n < MAX_PATH) ? std::wstring(buf) : std::wstring(L".");
    std::wstring safe;
    for (wchar_t c : g_title) {
        if ((c >= L'0' && c <= L'9') || (c >= L'A' && c <= L'Z') ||
            (c >= L'a' && c <= L'z') || c == L'-' || c == L'_') {
            safe.push_back(c);
        }
    }
    if (safe.empty()) safe = L"default";
    if (safe.size() > 40) safe.resize(40);
    root += L"\\bl-player";
    ::CreateDirectoryW(root.c_str(), nullptr);
    root += L"\\" + safe;
    ::CreateDirectoryW(root.c_str(), nullptr);
    return root;
}

// --------------------------------------------------------------------- COM

template <typename TInterface, typename TImpl>
class ComBase : public TInterface {
    volatile LONG m_ref;

public:
    ComBase() : m_ref(1) {}
    virtual ~ComBase() {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == __uuidof(TInterface) || riid == IID_IUnknown) {
            *ppv = static_cast<TInterface*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)::InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG c = ::InterlockedDecrement(&m_ref);
        if (c == 0) delete static_cast<TImpl*>(this);
        return (ULONG)c;
    }
};

// ---------------------------------------------------------------- bootstrap

// The document the WebView actually navigates to. It is deliberately tiny: the
// real application HTML lives in the RCDATA resource, gzip compressed, and this
// bootstrap inflates it with the platform's own DecompressionStream.
//
// Why not just declare `Content-Encoding: gzip` on that resource? Because
// WebView2 does not run HTTP content decoding on responses injected through
// WebResourceRequested. The intercepted request never carries Accept-Encoding,
// so no decoder is ever engaged and the renderer receives the raw deflate
// stream — which, declared as text/html, renders as garbage text on screen.
// (MicrosoftEdge/WebView2Feedback#3629; also reported by the Construct author
// for `Content-Encoding: deflate`.) Inflating here instead costs zero bytes of
// host code and keeps the payload compressed on disk.
static const char kBootstrapTemplate[] =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>bl-player</title>"
    "<style>html,body{margin:0;height:100%;background:#101014;color:#cfcfd6;"
    "font:13px/1.6 system-ui,'Segoe UI',sans-serif}"
    "#s{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;"
    "text-align:center;padding:24px;white-space:pre-wrap}</style></head><body>"
    "<div id=\"s\">Loading...</div>"
    "<script>(async()=>{"
    "var s=document.getElementById('s');"
    "var set=function(t){if(s)s.textContent=t};"
    "try{"
    "if(typeof DecompressionStream!=='function')"
    "throw new Error('DecompressionStream is unavailable');"
    "var r=await fetch('%PAYLOAD%',{cache:'no-store'});"
    "if(!r.ok)throw new Error('HTTP '+r.status);"
    "var t=await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();"
    "document.open();document.write(t);document.close();"
    "}catch(e){set('Failed to start: '+(e&&e.message?e.message:e))}"
    "})();</script></body></html>";

static std::string BootstrapHtml() {
    std::string html(kBootstrapTemplate);
    const std::string token = "%PAYLOAD%";
    size_t at = html.find(token);
    if (at != std::string::npos) {
        html.replace(at, token.size(), g_payloadGzip ? "app.html.gz" : "app.html");
    }
    return html;
}

// Serves every request under the custom origin out of the embedded resource.
class ResHandler
    : public ComBase<ICoreWebView2WebResourceRequestedEventHandler, ResHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(
        ICoreWebView2* /*sender*/,
        ICoreWebView2WebResourceRequestedEventArgs* args) override {
        ICoreWebView2WebResourceRequest* req = nullptr;
        if (FAILED(args->get_Request(&req)) || !req) return S_OK;

        LPWSTR uri = nullptr;
        req->get_Uri(&uri);
        const std::wstring u = uri ? uri : L"";
        if (uri) ::CoTaskMemFree(uri);

        const bool isBootstrap = (u == kOriginUrl) || (u == kOriginPrefix) ||
                                 (u == L"https://bl.local");
        const bool isPayload = g_payloadGzip ? (u == L"https://bl.local/app.html.gz")
                                             : (u == L"https://bl.local/app.html");

        IStream* stream = nullptr;
        int status = 404;
        const wchar_t* reason = L"Not Found";
        const wchar_t* headers =
            L"Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store";
        std::string bootstrap;

        if (isBootstrap) {
            bootstrap = BootstrapHtml();
            stream = ::SHCreateMemStream(
                reinterpret_cast<const BYTE*>(bootstrap.data()), (UINT)bootstrap.size());
            status = 200;
            reason = L"OK";
            headers = L"Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store";
        } else if (isPayload && g_payload && g_payloadLen) {
            stream = ::SHCreateMemStream(g_payload, g_payloadLen);
            status = 200;
            reason = L"OK";
            // Deliberately no Content-Encoding here: the page inflates it. See
            // the comment on kBootstrapTemplate.
            headers = L"Content-Type: application/octet-stream\r\nCache-Control: no-store";
        }

        if (g_env) {
            ICoreWebView2WebResourceResponse* resp = nullptr;
            if (SUCCEEDED(g_env->CreateWebResourceResponse(stream, status, reason, headers, &resp)) &&
                resp) {
                args->put_Response(resp);
                resp->Release();
            }
        }
        if (stream) stream->Release();
        req->Release();
        return S_OK;
    }
};

// Smoke test: read the live VM's state back out, then quit. The probe has to
// wait for targets to exist rather than for `window.vm` to exist: the VM object
// is constructed before loadProject() has built the stage, so an early poll
// happily reports vm:true, targets:0.
static int ExtractInt(const std::wstring& s, const wchar_t* key) {
    size_t at = s.find(key);
    if (at == std::wstring::npos) return -1;
    size_t colon = s.find(L':', at + wcslen(key));
    if (colon == std::wstring::npos) return -1;
    int value = 0;
    bool any = false;
    for (size_t i = colon + 1; i < s.size(); i++) {
        const wchar_t c = s[i];
        if (c >= L'0' && c <= L'9') {
            value = value * 10 + (c - L'0');
            any = true;
        } else if (any) {
            break;
        } else if (c != L' ') {
            break;
        }
    }
    return any ? value : -1;
}

class ScriptHandler
    : public ComBase<ICoreWebView2ExecuteScriptCompletedHandler, ScriptHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, LPCWSTR json) override {
        g_probeTries++;
        const std::wstring result =
            (SUCCEEDED(errorCode) && json) ? json : L"{\"error\":\"ExecuteScript failed\"}";
        // ExecuteScript returns the script's value JSON-encoded, so a fully
        // loaded project shows up as the escaped substring \"targets\":<n>.
        const int targets = ExtractInt(result, L"targets");
        const bool loaded = targets > 0;
        if (loaded || g_probeTries >= kProbeMaxTries) {
            WriteUtf8File(g_probePath, result);
            g_probeDone = true;
            ::PostQuitMessage(loaded ? 0 : 2);
        }
        return S_OK;
    }
};

class ControllerHandler
    : public ComBase<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                    ControllerHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode,
                                     ICoreWebView2Controller* controller) override {
        if (FAILED(errorCode) || !controller) {
            FailFast(L"WebView2 controller creation failed.", 3);
            return S_OK;
        }
        g_controller = controller;
        g_controller->AddRef();
        if (FAILED(g_controller->get_CoreWebView2(&g_webview)) || !g_webview) {
            FailFast(L"ICoreWebView2 is unavailable.", 4);
            return S_OK;
        }

        ICoreWebView2Settings* settings = nullptr;
        if (SUCCEEDED(g_webview->get_Settings(&settings)) && settings) {
            settings->put_IsScriptEnabled(TRUE);
            settings->put_AreDefaultScriptDialogsEnabled(TRUE);
            settings->put_IsStatusBarEnabled(FALSE);
            if (!g_allowDevTools) settings->put_AreDevToolsEnabled(FALSE);
            settings->Release();
        }

        RECT bounds = {0, 0, 0, 0};
        ::GetClientRect(g_hwnd, &bounds);
        g_controller->put_Bounds(bounds);
        g_controller->put_IsVisible(TRUE);

        ::EventRegistrationToken token = {};
        g_webview->AddWebResourceRequestedFilter(L"https://bl.local/*",
                                                 COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        g_webview->add_WebResourceRequested(new ResHandler(), &token);
        g_webview->Navigate(kOriginUrl);
        if (!g_probePath.empty()) ::SetTimer(g_hwnd, 1, kProbeIntervalMs, nullptr);
        return S_OK;
    }
};

class EnvHandler
    : public ComBase<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, EnvHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode,
                                     ICoreWebView2Environment* env) override {
        if (FAILED(errorCode) || !env) {
            FailFast(L"Microsoft Edge WebView2 Runtime is missing or failed to start.", 5);
            return S_OK;
        }
        g_env = env;
        g_env->AddRef();
        g_env->CreateCoreWebView2Controller(g_hwnd, new ControllerHandler());
        return S_OK;
    }
};

// -------------------------------------------------------------------- window

// Fullscreen is borderless-maximised: the caption and the resize frame are
// removed and the window is moved onto the whole monitor area. One function
// because three things toggle it (F11, Escape, and app.meta at startup) and
// they must agree about what "saved" means.
static bool g_fullscreen = false;
static RECT g_savedRect = {};
static LONG_PTR g_savedStyle = 0;

static void SetFullscreen(HWND hwnd, bool on) {
    if (on == g_fullscreen) return;
    g_fullscreen = on;
    if (on) {
        ::GetWindowRect(hwnd, &g_savedRect);
        g_savedStyle = ::GetWindowLongPtrW(hwnd, GWL_STYLE);
        MONITORINFO mi = {sizeof(mi)};
        ::GetMonitorInfoW(::MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi);
        ::SetWindowLongPtrW(hwnd, GWL_STYLE, g_savedStyle & ~(WS_CAPTION | WS_THICKFRAME));
        ::SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                       mi.rcMonitor.right - mi.rcMonitor.left,
                       mi.rcMonitor.bottom - mi.rcMonitor.top,
                       SWP_NOZORDER | SWP_FRAMECHANGED);
    } else {
        ::SetWindowLongPtrW(hwnd, GWL_STYLE, g_savedStyle);
        ::SetWindowPos(hwnd, HWND_TOP, g_savedRect.left, g_savedRect.top,
                       g_savedRect.right - g_savedRect.left, g_savedRect.bottom - g_savedRect.top,
                       SWP_NOZORDER | SWP_FRAMECHANGED);
    }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_SIZE:
            if (g_controller) {
                RECT bounds = {0, 0, LOWORD(lp), HIWORD(lp)};
                g_controller->put_Bounds(bounds);
            }
            return 0;
        case WM_TIMER:
            if (wp == 1 && g_webview && !g_probeDone) {
                g_webview->ExecuteScript(
                    L"JSON.stringify({"
                    L"title:document.title,"
                    L"vm:!!window.vm,"
                    L"targets:(window.vm&&window.vm.runtime&&window.vm.runtime.targets)"
                    L"?window.vm.runtime.targets.length:-1,"
                    L"assets:(window.vm&&window.vm.runtime&&window.vm.runtime.targets)"
                    L"?window.vm.runtime.targets.reduce(function(n,t){"
                    L"return n+t.sprite.costumes.length+t.sprite.sounds.length},0):-1,"
                    L"canvas:document.querySelectorAll('canvas').length,"
                    L"ms:Math.round(performance.now()),"
                    L"error:(document.getElementById('error')&&!document.getElementById('error').hidden)"
                    L"?document.getElementById('error-message').textContent:null"
                    L"})",
                    new ScriptHandler());
            }
            return 0;
        case WM_KEYDOWN:
            if (wp == VK_F11) {
                SetFullscreen(hwnd, !g_fullscreen);
            } else if (wp == VK_ESCAPE && g_fullscreen) {
                // Escape leaves fullscreen and nothing else. Only when the window
                // is actually fullscreen, so the page keeps its own Escape
                // (pointer lock, dialogs) in every other case.
                SetFullscreen(hwnd, false);
                return 0;
            } else if (wp == VK_F12 && g_webview && g_allowDevTools) {
                g_webview->OpenDevToolsWindow();
            }
            return 0;
        case WM_DESTROY:
            ::PostQuitMessage(0);
            return 0;
        default:
            break;
    }
    return ::DefWindowProcW(hwnd, msg, wp, lp);
}

int APIENTRY wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR, int) {
    ::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    const BYTE* meta = nullptr;
    DWORD metaLen = 0;
    if (LoadRes(inst, IDR_META, &meta, &metaLen)) ParseMeta(meta, metaLen);

    if (!LoadRes(inst, IDR_PAYLOAD, &g_payload, &g_payloadLen)) {
        FailFast(L"Embedded payload resource is missing.", 6);
        return 1;
    }

    WNDCLASSEXW wc = {sizeof(wc)};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = ::LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)::GetStockObject(BLACK_BRUSH);
    wc.lpszClassName = L"BlPlayerWindow";
    // Resource 1 is the ICON statement the packager writes when --icon was given.
    // Both sizes matter: hIcon is the taskbar/alt-tab image, hIconSm the title
    // bar's. Absent resource => NULL => Windows' default, as before.
    wc.hIcon = (HICON)::LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                   ::GetSystemMetrics(SM_CXICON),
                                   ::GetSystemMetrics(SM_CYICON), 0);
    wc.hIconSm = (HICON)::LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                     ::GetSystemMetrics(SM_CXSMICON),
                                     ::GetSystemMetrics(SM_CYSMICON), 0);
    ::RegisterClassExW(&wc);

    RECT r = {0, 0, g_width, g_height};
    ::AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    g_hwnd = ::CreateWindowExW(0, wc.lpszClassName, g_title.c_str(), WS_OVERLAPPEDWINDOW,
                               CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left,
                               r.bottom - r.top, nullptr, nullptr, inst, nullptr);
    if (!g_hwnd) {
        FailFast(L"CreateWindowExW failed.", 7);
        return 1;
    }
    // app.meta's `window=` chooses how the first frame appears. "fullscreen" is
    // the same borderless mode F11 gives, so Escape has one meaning everywhere.
    if (g_windowMode == L"fullscreen") {
        ::ShowWindow(g_hwnd, SW_SHOW);
        SetFullscreen(g_hwnd, true);
    } else if (g_windowMode == L"maximize") {
        ::ShowWindow(g_hwnd, SW_SHOWMAXIMIZED);
    } else {
        ::ShowWindow(g_hwnd, SW_SHOW);
    }
    ::UpdateWindow(g_hwnd);

    // A null environment options means "use the installed Evergreen Runtime
    // with its default browser arguments". The custom user data folder is what
    // makes the second launch of a large project fast (warm HTTP + shader cache).
    const std::wstring udf = UserDataFolder();
    ::CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), nullptr, new EnvHandler());

    MSG msg;
    while (::GetMessageW(&msg, nullptr, 0, 0)) {
        ::TranslateMessage(&msg);
        ::DispatchMessageW(&msg);
    }
    return 0;
}
