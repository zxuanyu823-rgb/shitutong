#!/bin/sh
# 不依赖 Gradle 的打包脚本：aapt2 + javac + d8 + zipalign + apksigner
set -e
SDK=${ANDROID_HOME:-/home/claude/android-sdk}
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-34/android.jar
cd "$(dirname "$0")"
rm -rf build && mkdir -p build/assets/web build/classes build/dex
# 网页文件
(cd ../web && find . -type f ! -name preview.html ! -name package.json ! -path "./test/*" | while read f; do mkdir -p "../android/build/assets/web/$(dirname "$f")"; cp "$f" "../android/build/assets/web/$f"; done)
$BT/aapt2 compile --dir res -o build/res.zip
$BT/aapt2 link -o build/base.apk -I $JAR --manifest AndroidManifest.xml -A build/assets \
  --min-sdk-version 24 --target-sdk-version 34 --version-code ${VERSION_CODE:-2} --version-name ${VERSION_NAME:-1.1} build/res.zip
javac -g:none -encoding UTF-8 -source 8 -target 8 -bootclasspath $JAR -cp $JAR -d build/classes $(find src -name '*.java') 2>&1 | grep -v -i "warning\|JAVA_TOOL" || true
$BT/d8 --min-api 24 --release --lib $JAR --output build/dex $(find build/classes -name '*.class')
cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
$BT/zipalign -p -f 4 build/unsigned.apk build/aligned.apk
[ -f release.keystore ] || keytool -genkeypair -keystore release.keystore -storepass shitutong -keypass shitutong -alias shitutong -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Shitutong" 2>/dev/null
$BT/apksigner sign --ks release.keystore --ks-pass pass:shitutong --key-pass pass:shitutong --out build/shitutong.apk build/aligned.apk
$BT/apksigner verify build/shitutong.apk && echo "APK: $(pwd)/build/shitutong.apk ($(du -h build/shitutong.apk | cut -f1))"
