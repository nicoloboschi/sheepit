package com.nicoloboschi.vipershell;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Reports the *static* system-bar insets to CSS as --safe-top-native /
 * --safe-bottom-native.
 *
 * Why this exists at all: env(safe-area-inset-bottom) reports 0 in Android's
 * WebView. env() covers the status bar and display cutouts but not the gesture
 * navigation bar, so relying on it alone left the mobile keybar drawn beneath
 * the gesture pill. style.css therefore takes max(env(), native) per edge.
 *
 * What it deliberately does NOT report is the IME. index.html declares
 * `interactive-widget=resizes-visual`, so an open keyboard already shrinks the
 * visual viewport, which App.tsx tracks as --vvh. An earlier version folded
 * WindowInsetsCompat.Type.ime() in here as well, and the keyboard height was
 * then subtracted twice — the layout moved but ended up misaligned. Keyboard
 * handling belongs to the web layer; this class only answers "how big are the
 * system bars".
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebView webView = getBridge().getWebView();
        // The content root always receives insets; a listener on the WebView
        // can be starved if a parent consumes them first.
        final View root = findViewById(android.R.id.content);

        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());

            // CSS works in density-independent pixels; Insets are physical px.
            float density = getResources().getDisplayMetrics().density;
            int top    = Math.round(bars.top / density);
            int bottom = Math.round(bars.bottom / density);
            int left   = Math.round(bars.left / density);
            int right  = Math.round(bars.right / density);

            final String js =
                    "(function(s){"
                  + "s.setProperty('--safe-top-native','" + top + "px');"
                  + "s.setProperty('--safe-bottom-native','" + bottom + "px');"
                  + "s.setProperty('--safe-left-native','" + left + "px');"
                  + "s.setProperty('--safe-right-native','" + right + "px');"
                  + "})(document.documentElement.style)";

            // Insets can arrive before the page is ready, and again on rotation
            // or when the bars auto-hide; a superseded early call is harmless.
            webView.post(() -> webView.evaluateJavascript(js, null));

            // Unconsumed, so children still receive them.
            return windowInsets;
        });

        ViewCompat.requestApplyInsets(root);
    }
}
