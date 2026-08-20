# ALAC decoder

This Android-only module adds Media3's FFmpeg audio renderer to Resonus. The
extension renderer is registered after the platform renderers, and the native
library contains the `alac` decoder only. Devices with a working platform ALAC
decoder still use it; FFmpeg is used only when the platform cannot handle an
ALAC stream. Every other audio format continues to use the device decoder
selected by `expo-audio`.

Source provenance:

- Media3 decoder sources: [`androidx/media` 1.9.0][media3-source], commit
  `7cc1056f840ce226598d3b990d4a6f7cd17e2831`. The unfinished video renderer is
  omitted; the included audio sources are otherwise unchanged.
- FFmpeg: [n6.0.1][ffmpeg-source], commit
  `c41ff724ede7da657762d61097e26fac296c53bf`.
- Native targets: `armeabi-v7a` and `arm64-v8a`, Android API 21, NDK
  26.1.10909125.
- Enabled FFmpeg decoder: `alac` only.
- `libffmpegJNI.so` SHA-256:
  - `armeabi-v7a`:
    `d25836985c6d7542ccda1bb467f15e1bffb1bab3a1fabf120bda851fb18bf3b3`
  - `arm64-v8a`:
    `13289a6d804122a74de59c40f2e9d4705d75849073a2b716155c1977d18a4b3e`

The native libraries were built with Media3's upstream `build_ffmpeg.sh` flags
(`--disable-everything`, `--enable-swresample`, and
`--enable-decoder=alac`) and its upstream `CMakeLists.txt`. The JNI libraries
are stripped and use 16 KB ELF load-segment alignment.

The Java renderer sources retain their upstream Apache-2.0 headers. FFmpeg's
license for this configuration is LGPL-2.1-or-later; its license text is in
[`LICENSE.LGPL-2.1`](LICENSE.LGPL-2.1).

[media3-source]: https://github.com/androidx/media/tree/7cc1056f840ce226598d3b990d4a6f7cd17e2831/libraries/decoder_ffmpeg
[ffmpeg-source]: https://github.com/FFmpeg/FFmpeg/tree/c41ff724ede7da657762d61097e26fac296c53bf
