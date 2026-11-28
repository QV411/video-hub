import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Persist the release fix outside gen/: safe to rerun after every android init.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = join(root, "src-tauri/gen/android/app/src/main");
const manifest = join(main, "AndroidManifest.xml");
if (existsSync(manifest)) {
  const java = join(main, "java/com/videohub/player");
  mkdirSync(java, { recursive: true });
  copyFileSync(join(root, "src-tauri/android/OrientationPlugin.kt"), join(java, "OrientationPlugin.kt"));
  copyFileSync(join(root, "src-tauri/android/LoginWebViewProfile.kt"), join(java, "LoginWebViewProfile.kt"));
  for (const name of ["LoginWebViewPlugin.kt", "LoginWebViewActivity.kt", "PluginDocumentsPlugin.kt", "PluginDocumentPaths.kt", "StorageAccessPlugin.kt"]) {
    copyFileSync(join(root, "src-tauri/android", name), join(java, name));
  }
  const test = join(main, "../androidTest");
  const testJava = join(test, "java/com/videohub/player");
  mkdirSync(testJava, { recursive: true });
  copyFileSync(join(root, "src-tauri/android/tests/LoginProfileIsolationTest.kt"), join(testJava, "LoginProfileIsolationTest.kt"));
  copyFileSync(join(root, "src-tauri/android/tests/AndroidManifest.xml"), join(test, "AndroidManifest.xml"));
  copyFileSync(join(root, "src-tauri/android/tests/ProcessLoginIsolationTest.kt"), join(testJava, "ProcessLoginIsolationTest.kt"));
  const unit = join(main, "../test/java/com/videohub/player");
  mkdirSync(unit, { recursive: true });
  copyFileSync(join(root, "src-tauri/android/tests/PluginDocumentPathsTest.kt"), join(unit, "PluginDocumentPathsTest.kt"));
  const debug = join(main, "../debug");
  const debugJava = join(debug, "java/com/videohub/player");
  mkdirSync(debugJava, { recursive: true });
  copyFileSync(join(root, "src-tauri/android/tests/process/ProcessIsolationFixture.kt"), join(debugJava, "ProcessIsolationFixture.kt"));
  copyFileSync(join(root, "src-tauri/android/tests/process/AndroidManifest.xml"), join(debug, "AndroidManifest.xml"));
  mkdirSync(join(main, "res/xml"), { recursive: true });
  copyFileSync(join(root, "src-tauri/android/network_security_config.xml"), join(main, "res/xml/network_security_config.xml"));
  // Bundled FFmpeg (LGPL) for TS→MP4 remux: executable + libav* dependencies.
  // Copied into jniLibs so the installer extracts them to nativeLibraryDir,
  // where the ffmpeg child process can be executed and resolve its dependencies.
  const jniSrc = join(root, "src-tauri/android/jniLibs/arm64-v8a");
  const jniDst = join(main, "jniLibs/arm64-v8a");
  mkdirSync(jniDst, { recursive: true });
  if (existsSync(jniSrc)) {
    for (const name of readdirSync(jniSrc).filter(n => n.endsWith(".so"))) {
      copyFileSync(join(jniSrc, name), join(jniDst, name));
    }
  }
  // The bundled ffmpeg is exec'd from nativeLibraryDir; pin legacy JNI
  // packaging (extract on install) to match android:extractNativeLibs="true"
  // and silence the AGP useLegacyPackaging advisory.
  const gradleKts = join(main, "..", "..", "build.gradle.kts");
  if (existsSync(gradleKts)) {
    let gradle = readFileSync(gradleKts, "utf8");
    if (!gradle.includes("useLegacyPackaging")) {
      gradle = gradle.replace(
        /defaultConfig \{/,
        "defaultConfig {\n        packaging { jniLibs.useLegacyPackaging = true }"
      );
      writeFileSync(gradleKts, gradle);
    }
  }
  let xml = readFileSync(manifest, "utf8");
  if (/android:networkSecurityConfig=/.test(xml)) xml = xml.replace(/android:networkSecurityConfig="[^"]*"/, 'android:networkSecurityConfig="@xml/network_security_config"');
  else xml = xml.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/network_security_config"');
  // The bundled ffmpeg is exec'd as a child process from nativeLibraryDir;
  // libraries must be extracted on install rather than loaded from the APK.
  if (!xml.includes("android:extractNativeLibs=")) {
    xml = xml.replace(/<application\b/, '<application android:extractNativeLibs="true"');
  }
  if (!xml.includes('android:name=".LoginWebViewActivity"')) {
    xml = xml.replace("</application>", '    <activity android:name=".LoginWebViewActivity" android:exported="false" android:process=":hpp_login" android:configChanges="orientation|keyboardHidden|keyboard|screenSize|screenLayout|smallestScreenSize|uiMode" android:theme="@android:style/Theme.Material.Light.NoActionBar" />\n    </application>');
  }
  // Download module: all-files access for the public shared folder on API 30+.
  // WRITE_EXTERNAL_STORAGE is kept only for legacy <= API 28 installs.
  const permissions = [
    '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
  ];
  for (const perm of permissions) {
    if (!xml.includes(perm.replace(/\s*\/>$/, "").split("\"")[1])) xml = xml.replace(/<application\b/, `    ${perm}\n    <application`);
  }
  writeFileSync(manifest, xml);
  console.log("[android] 已同步应用内媒体回环网络配置");
}
