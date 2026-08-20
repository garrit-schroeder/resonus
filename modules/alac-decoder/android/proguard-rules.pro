# The renderer itself is discovered by DefaultRenderersFactory using reflection.
-keep class androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer { public <init>(...); }

# Native JNI entry points and the callback invoked from ffmpeg_jni.cc.
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep, includedescriptorclasses class androidx.media3.decoder.ffmpeg.FfmpegAudioDecoder {
  private java.nio.ByteBuffer growOutputBuffer(androidx.media3.decoder.SimpleDecoderOutputBuffer, int);
}
