#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

KEYSTORE_DIR=".release"
KEYSTORE_FILE="$KEYSTORE_DIR/myrelease-release.jks"

export RESONUS_KEYSTORE_PASSWORD="X"
export RESONUS_KEY_ALIAS="myrelease"
export RESONUS_KEY_PASSWORD="X"
export RESONUS_KEYSTORE_FILE="$PWD/$KEYSTORE_FILE"
export EXPO_PUBLIC_COMMIT="$(git rev-parse HEAD)"

mkdir -p "$KEYSTORE_DIR"
if [[ ! -f "$KEYSTORE_FILE" ]]; then
  keytool -genkeypair -v \
    -keystore "$KEYSTORE_FILE" \
    -alias "$RESONUS_KEY_ALIAS" \
    -storetype PKCS12 \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$RESONUS_KEYSTORE_PASSWORD" \
    -keypass "$RESONUS_KEY_PASSWORD" \
    -dname "CN=myrelease, OU=local, O=myrelease, L=local, ST=local, C=DE" >/dev/null
fi

pnpm expo prebuild --clean -p android
(
  cd android
  ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a
)

adb install -r android/app/build/outputs/apk/release/app-release.apk
