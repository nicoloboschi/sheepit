# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ---------------------------------------------------------------------------
# Capacitor
#
# Capacitor discovers plugins, their @PluginMethod entry points and their
# declared permissions by reflecting over annotations at runtime. The consumer
# rules shipped in @capacitor/android keep the plugin *classes*, but not the
# annotation attributes themselves — so with R8 on, Plugin.getPermissionStates()
# reads a null @CapacitorPlugin annotation and the app dies on launch with:
#
#   java.lang.NullPointerException
#     at com.getcapacitor.Plugin.getPermissionStates
#     at ...LocalNotificationsPlugin.checkPermissions
#
# Keeping the annotations and the (small) Capacitor runtime costs very little
# here: the web assets dominate the APK, not the Java.
# ---------------------------------------------------------------------------
-keepattributes *Annotation*
-keepattributes RuntimeVisibleAnnotations
-keepattributes RuntimeVisibleParameterAnnotations
-keepattributes AnnotationDefault

-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }
-keep @interface com.getcapacitor.** { *; }
-keep class com.capacitorjs.plugins.** { *; }

# Plugins are instantiated by name from the generated plugin list.
-keep class * extends com.getcapacitor.Plugin { *; }

# The WebView calls into the bridge across the JS interface boundary.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
