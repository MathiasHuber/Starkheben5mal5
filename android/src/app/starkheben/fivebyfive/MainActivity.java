package app.starkheben.fivebyfive;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Hosts the bundled web app from the APK's assets. Everything stays on the device: the app has no
 * internet permission and keeps its data in the WebView's storage. Import and export go through
 * Android's own file pickers.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "file:///android_asset/index.html";
    private static final int REQUEST_IMPORT = 1;
    private static final int REQUEST_EXPORT = 2;

    private WebView web;
    private ValueCallback<Uri[]> pendingImport;
    private String pendingExport;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Drawn edge to edge (required from Android 15 on): keep the page clear of the system bars.
        FrameLayout root = new FrameLayout(this);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
        });

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // workouts are kept in localStorage
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "StarkhebenAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file:///android_asset/")) return false;
                // Any outside link opens in the browser instead of inside the app.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingImport != null) pendingImport.onReceiveValue(null);
                pendingImport = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(pick, REQUEST_IMPORT);
                } catch (Exception e) {
                    pendingImport = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(START_URL);
        }
    }

    /** Called from the page: `window.StarkhebenAndroid.exportFile(name, text)`. */
    private class Bridge {
        @JavascriptInterface
        public void exportFile(final String name, final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pendingExport = text;
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    save.addCategory(Intent.CATEGORY_OPENABLE);
                    save.setType("application/json");
                    save.putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(save, REQUEST_EXPORT);
                    } catch (Exception e) {
                        pendingExport = null;
                        notifyExport(false);
                    }
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (requestCode == REQUEST_IMPORT && pendingImport != null) {
            pendingImport.onReceiveValue(uri != null ? new Uri[] { uri } : null);
            pendingImport = null;
        } else if (requestCode == REQUEST_EXPORT) {
            boolean ok = false;
            if (uri != null && pendingExport != null) {
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    out.write(pendingExport.getBytes(StandardCharsets.UTF_8));
                    ok = true;
                } catch (Exception e) {
                    Toast.makeText(this, "Couldn't save the file.", Toast.LENGTH_LONG).show();
                }
            }
            pendingExport = null;
            notifyExport(ok);
        }
    }

    private void notifyExport(boolean ok) {
        web.evaluateJavascript("window.onAndroidExport && window.onAndroidExport(" + ok + ")", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }
}
