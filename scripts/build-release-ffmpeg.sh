#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) build_target=darwin-arm64 ;;
  Darwin-x86_64) build_target=darwin-x64 ;;
  Linux-x86_64) build_target=linux-x64 ;;
  MINGW*-x86_64|MSYS*-x86_64) build_target=win32-x64 ;;
  *) echo "Unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
if [[ -n "${MEDIA_GRAB_EXPECTED_TARGET:-}" && "$MEDIA_GRAB_EXPECTED_TARGET" != "$build_target" ]]; then
  echo "Expected $MEDIA_GRAB_EXPECTED_TARGET, got $build_target" >&2
  exit 1
fi

input_directory="${MEDIA_GRAB_RELEASE_INPUTS_DIR:-$repository_root/.release-tools/$build_target}"
source_directory="$input_directory/sources"
records_directory="$input_directory/build-records"
build_directory="$(mktemp -d "${TMPDIR:-/tmp}/mediagrab-ffmpeg.XXXXXX")"
trap 'rm -r "$build_directory"' EXIT
mkdir -p "$records_directory"
tar -xf "$source_directory/ffmpeg.tar.xz" -C "$build_directory"
tar -xf "$source_directory/lame.tar.gz" -C "$build_directory"
ffmpeg_source=("$build_directory"/ffmpeg-*)
lame_source=("$build_directory"/lame-*)
install_directory="$build_directory/install"
build_jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"

lame_options=(--prefix="$install_directory" --disable-shared --enable-static --disable-frontend --disable-dependency-tracking --with-pic)
compiler=cc
linker_options="-L$install_directory/lib"
thread_options=(--enable-pthreads)
binary_suffix=
if [[ "$build_target" == win32-x64 ]]; then
  compiler=gcc
  binary_suffix=.exe
  lame_options+=(--build=x86_64-pc-msys --host=x86_64-w64-mingw32 --disable-nasm)
  linker_options+=" -static"
  thread_options=(--disable-pthreads --enable-w32threads)
elif [[ "$build_target" == darwin-* ]]; then
  compiler=clang
fi

(
  cd "${lame_source[0]}"
  CC="$compiler" ./configure "${lame_options[@]}" > "$records_directory/lame-configure.log" 2>&1
  make -j "$build_jobs" > "$records_directory/lame-make.log" 2>&1
  make install >> "$records_directory/lame-make.log" 2>&1
)
(
  cd "${ffmpeg_source[0]}"
  ./configure \
    --prefix="$install_directory" --cc="$compiler" \
    --disable-autodetect --disable-x86asm --enable-static --disable-shared \
    --disable-debug --disable-doc --disable-ffplay --disable-ffprobe \
    --disable-network --disable-everything --disable-gpl --disable-nonfree \
    --enable-ffmpeg --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample \
    --enable-protocol=file --enable-demuxer=mov,matroska,ogg,mp3,pcm_s16le \
    --enable-muxer=mp4,ipod,matroska,webm,mp3 \
    --enable-decoder=aac,alac,flac,mp3,opus,vorbis,pcm_s16le,pcm_s24le,pcm_s32le,h264,hevc,vp8,vp9,av1 \
    --enable-encoder=libmp3lame --enable-libmp3lame --enable-filter=aresample,format \
    --enable-parser=aac,ac3,flac,h264,hevc,mpegaudio,opus,vorbis,vp3,vp8,vp9,av1 \
    --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb \
    "${thread_options[@]}" --extra-cflags="-I$install_directory/include" \
    --extra-ldflags="$linker_options" > "$records_directory/ffmpeg-configure.log" 2>&1
  cp ffbuild/config.log "$records_directory/ffmpeg-config.log"
  make -j "$build_jobs" > "$records_directory/ffmpeg-make.log" 2>&1
  cp "ffmpeg$binary_suffix" "$input_directory/ffmpeg$binary_suffix"
  ./ffmpeg"$binary_suffix" -buildconf > "$records_directory/ffmpeg-buildconf.txt" 2>&1
)
cp "${ffmpeg_source[0]}/COPYING.LGPLv2.1" "$input_directory/ffmpeg-license.txt"
cp "${lame_source[0]}/COPYING" "$input_directory/lame-license.txt"
cp "$repository_root/scripts/build-release-ffmpeg.sh" "$records_directory/"
tar -czf "$records_directory/ffmpeg-relink-kit.tar.gz" -C "$build_directory" .
echo "Built FFmpeg for $build_target"
