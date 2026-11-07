package com.nicoloboschi.sheepit;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update: download the APK the sheepit server is serving and hand it to
 * Android's package installer.
 *
 * An app outside the Play Store cannot install itself silently; Android always
 * shows its own "Install" sheet, and the first time it asks you to allow this
 * app to install apps at all. Everything up to that sheet is done here, so an
 * update is one tap.
 *
 * The URL comes from the page (it knows the server and the password, as `k=`).
 * Same signing key every build (see scripts/android.sh), so it installs over
 * the top and keeps the app's data.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("Bad url");
            return;
        }
        // Android 8+: "install unknown apps" is a per-app switch. Without it the
        // installer refuses, so send the user to the switch first.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(allow);
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        new Thread(() -> {
            File out = new File(getContext().getCacheDir(), "sheepit-update.apk");
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("ngrok-skip-browser-warning", "1");
                int code = conn.getResponseCode();
                String type = conn.getContentType();
                if (code != 200 || type == null || !type.contains("android.package-archive")) {
                    call.reject("Server answered " + code + " " + type);
                    return;
                }
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                Uri uri = FileProvider.getUriForFile(getContext(),
                        getContext().getPackageName() + ".fileprovider", out);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                JSObject r = new JSObject();
                r.put("started", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}
