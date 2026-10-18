package app.shitutong;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.MutableContextWrapper;
import android.content.pm.PackageManager;
import android.os.Build;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

// 视图通安卓版：用 WebView 运行网页版，网页文件打包在 assets/web 里，通过虚拟 https 域名提供，
// 这样 ES 模块、Web Worker、WASM 都能正常加载；大模型和搜索请求走原生网络，不受跨域限制。
public class MainActivity extends Activity {
    static final String HOST = "appassets.shitutong.local";
    static final int PICK = 1;
    // 网页（连同里面正在跑的识图建模）跟着进程走，不跟着界面走：
    // 界面因为系统设置变化、内存整理被销毁重建时，把同一个 WebView 接到新界面上，网页不重新加载
    static WebView web;
    static MainActivity current;
    static ValueCallback<Uri[]> fileCb;
    static volatile boolean visible;
    static boolean askedNotify;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        current = this;
        if (web != null) {
            ((MutableContextWrapper) web.getContext()).setBaseContext(this);
            ViewGroup p = (ViewGroup) web.getParent();
            if (p != null) p.removeView(web);
            setContentView(web);
            return;
        }
        // 进程是新的：b != null 说明之前在后台被系统回收过，网页据此提示“继续上次的拍照建模”
        createWeb(b != null);
    }

    void createWeb(boolean recovered) {
        web = new WebView(new MutableContextWrapper(this));
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 字号由 App 内“设置 → 字体大小”控制，不再叠加系统字体缩放（否则手机上布局会挤爆）
        s.setTextZoom(100);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        web.addJavascriptInterface(new Net(), "AndroidNet");
        // 切到后台时网页渲染进程仍保持“重要”优先级，不被系统冻结
        if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
                Map<String, String> h = new HashMap<>();
                h.put("Access-Control-Allow-Origin", "*");
                h.put("Cache-Control", "no-cache");
                try {
                    InputStream in = v.getContext().getApplicationContext().getAssets().open("web" + path);
                    String m = mime(path);
                    return new WebResourceResponse(m, m.startsWith("text") || m.contains("javascript") || m.contains("json") ? "utf-8" : null, 200, "OK", h, in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, new ByteArrayInputStream(new byte[0]));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { current.startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            // 网页渲染进程被系统回收（后台内存紧张）或崩溃：换一个新的 WebView 重新打开，而不是让整个 App 崩掉
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                if (v != web) return true;
                ViewGroup p = (ViewGroup) v.getParent();
                if (p != null) p.removeView(v);
                v.destroy();
                web = null;
                MainActivity a = current;
                if (a != null && !a.isFinishing() && !a.isDestroyed()) a.createWeb(true);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                try { current.startActivityForResult(Intent.createChooser(i, "选择题目照片"), PICK); }
                catch (Exception e) { fileCb.onReceiveValue(null); fileCb = null; return false; }
                return true;
            }
        });
        web.loadUrl("https://" + HOST + "/index.html" + (recovered ? "?recovered=1" : ""));
    }

    // 只是界面被销毁（进程还在）：把 WebView 从界面上摘下来留着，换回应用上下文，不泄漏旧界面
    @Override
    protected void onDestroy() {
        if (web != null && web.getParent() != null && web.getContext() instanceof MutableContextWrapper && ((MutableContextWrapper) web.getContext()).getBaseContext() == this) {
            ((ViewGroup) web.getParent()).removeView(web);
            ((MutableContextWrapper) web.getContext()).setBaseContext(getApplicationContext());
        }
        if (current == this) current = null;
        super.onDestroy();
    }

    // 注意：这里故意不调用 web.onPause()/pauseTimers()，让后台任务里的网页脚本继续运行
    @Override
    protected void onResume() { super.onResume(); current = this; visible = true; }

    @Override
    protected void onPause() { super.onPause(); visible = false; }

    // 安卓 13 起发通知需要用户同意；第一次开始长任务时问一次
    void askNotifyPermission() {
        if (askedNotify || Build.VERSION.SDK_INT < 33) return;
        askedNotify = true;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 9);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK || fileCb == null) return;
        Uri[] r = (res == RESULT_OK && data != null && data.getData() != null) ? new Uri[]{data.getData()} : null;
        fileCb.onReceiveValue(r);
        fileCb = null;
    }

    @Override
    public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else moveTaskToBack(true); }

    static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    static final android.os.Handler MAIN = new android.os.Handler(android.os.Looper.getMainLooper());
    static void ui(Runnable r) { MAIN.post(r); }
    static Context app() { return web != null ? web.getContext().getApplicationContext() : current.getApplicationContext(); }

    // 原生网络：JS 调 AndroidNet.post(id, url, headersJson, body)，结果回调 window.__netCb(id, status, text)
    static class Net {
        // 长任务开始/进行中（on=true，text 为进度）或结束（on=false）
        @JavascriptInterface
        public void busy(final boolean on, final String text) {
            ui(new Runnable() { public void run() {
                Context c = app();
                Intent i = new Intent(c, TaskService.class);
                if (!on) { try { c.stopService(i); } catch (Exception ignored) { } return; }
                // 服务已在运行：只更新通知栏文字
                if (TaskService.running) { TaskService.update(c, text); return; }
                // 前台服务只能在 App 处于前台时启动（用户刚点了按钮）
                if (!visible || current == null) return;
                current.askNotifyPermission();
                i.putExtra("text", text == null ? "" : text);
                try {
                    if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
                } catch (Exception ignored) { }
            } });
        }

        // App 不在前台时发一条完成提醒
        @JavascriptInterface
        public void notify(final String title, final String text) {
            if (visible) return;
            TaskService.done(app(), title, text);
        }

        @JavascriptInterface
        public void post(final String id, final String url, final String headers, final String body) {
            new Thread(new Runnable() {
                public void run() {
                    int status = 0;
                    boolean gotHeaders = false;
                    String text;
                    try {
                        if (!url.startsWith("https://")) throw new IOException("只允许 https 地址");
                        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                        c.setRequestMethod("POST");
                        c.setConnectTimeout(20000);
                        // 读超时是“多久没收到任何数据”，流式返回时每个字都会刷新它
                        c.setReadTimeout(150000);
                        c.setDoOutput(true);
                        JSONObject h = new JSONObject(headers);
                        Iterator<String> it = h.keys();
                        while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
                        OutputStream os = c.getOutputStream();
                        os.write(body.getBytes("UTF-8"));
                        os.close();
                        status = c.getResponseCode();
                        gotHeaders = true;
                        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                        text = in == null ? "" : read(in);
                    } catch (Exception e) {
                        // 0 = 没连上；-1 = 连上了但接收途中断开。text 带上异常类型，网页端据此给出可读的提示
                        status = gotHeaders ? -1 : 0;
                        text = e.getClass().getSimpleName() + ": " + e.getMessage();
                    }
                    final String js = "window.__netCb(" + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(text) + ")";
                    ui(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(js, null); } });
                }
            }).start();
        }
    }

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toString("UTF-8");
    }
}
