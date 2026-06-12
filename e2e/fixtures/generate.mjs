#!/usr/bin/env node
// generates committed test fixture files for e2e tests.
//
// requires: ffmpeg and imagemagick (magick).
//   brew install ffmpeg imagemagick
//
// audio:
//   tone-440hz-2s.wav            A4 sine 2s, no tags      (basic add/play)
//   tone-880hz-5s.wav            A5 sine 5s, no tags      (seek / position)
//   tone-220hz-10s.wav           A3 sine 10s, no tags     (prefetch window)
//   chord-stack-3s.wav           A maj chord 3s, no tags  (multi-partial wav)
//   tone-stereo-3s.wav           stereo A4 3s             (stereo channel)
//   tagged-c5-3s.{mp3,m4a,ogg}  C5 tone + full tags      (tag parsing x3 formats)
//   tagged-a3-4s.{mp3,m4a,ogg}  A3 tone + full tags      (second artist)
//   tagged-f4-6s.{mp3,m4a,ogg}  F4 tone + full tags      (third artist/album)
//   bare-glitch-1s.{mp3,m4a,ogg} 1s, no tags             (very short, tagless)
//   noisy-binaural-8s.mp3        stereo low drone 8s      (stereo mp3)
//   long-drone-90s.mp3           sub-bass 90s             (prefetch budget)
//
// images:
//   cover-red.png       128x128 flat red
//   cover-blue.png      128x128 flat blue
//   cover-checkers.png  64x64 checkerboard
//   cover-noise.png     256x256 deterministic rgb noise
//   cover-gradient.jpg  400x400 gradient
//   cover-portrait.jpg  300x500 portrait (non-square)
//   cover-thumb.jpg     48x48 tiny thumbnail
//   cover-plasma.webp   256x256 plasma
//   cover-wide.webp     600x200 landscape banner
//   cover-anim.gif      80x80 animated 4-frame colour cycle
//   cover-mono.gif      120x120 grayscale radial (non-animated)
//
// run once and commit:
//   node e2e/fixtures/generate.mjs

import { writeFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { deflateSync, crc32 } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const OUT = dirname(fileURLToPath(import.meta.url));

// --- helpers ---

function run(cmd, args) {
    try {
        execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
        return true;
    } catch (e) {
        const msg = e.stderr?.toString().slice(-300) ?? e.message;
        console.error(`  [error] ${cmd} ${args.slice(0, 5).join(" ")} ...\n    ${msg.trim()}`);
        return false;
    }
}

function tmp(ext) {
    return join(tmpdir(), `fix-gen-${randomBytes(4).toString("hex")}${ext}`);
}

function emit(name) {
    const p = join(OUT, name);
    const kb = existsSync(p) ? (statSync(p).size / 1024).toFixed(1) : "?";
    console.log(`  ${name}  (${kb} kB)`);
}

function write(name, data) {
    writeFileSync(join(OUT, name), data);
    emit(name);
}

// --- wav (pure Node) ---

function makeWav(durationSec, freqHz = 440, channels = 1) {
    const sampleRate = 22050;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2 * channels;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);              // PCM
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2 * channels, 28);
    buf.writeUInt16LE(2 * channels, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < numSamples; i++) {
        for (let ch = 0; ch < channels; ch++) {
            const f = freqHz * (1 + ch * 0.007); // slight detune per channel
            const v = Math.sin((2 * Math.PI * f * i) / sampleRate);
            buf.writeInt16LE(Math.floor(v * 0x4fff), 44 + (i * channels + ch) * 2);
        }
    }
    return buf;
}

// additive chord: partials = [[freq, amplitude], ...]
function makeChordWav(durationSec, partials) {
    const sampleRate = 22050;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(dataSize, 40);
    const totalAmp = partials.reduce((s, [, a]) => s + a, 0);
    for (let i = 0; i < numSamples; i++) {
        let v = 0;
        for (const [f, a] of partials) {
            v += (a / totalAmp) * Math.sin((2 * Math.PI * f * i) / sampleRate);
        }
        buf.writeInt16LE(Math.floor(v * 0x4fff), 44 + i * 2);
    }
    return buf;
}

// --- png (pure Node, no external deps) ---

function pngChunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const crcVal = crc32(data, crc32(typeBuf));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// pixelFn(x, y) -> [r, g, b]
function makePng(width, height, pixelFn) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor RGB
    const scanlineLen = 1 + width * 3;
    const raw = Buffer.alloc(height * scanlineLen);
    for (let y = 0; y < height; y++) {
        raw[y * scanlineLen] = 0; // filter type: None
        for (let x = 0; x < width; x++) {
            const [r, g, b] = pixelFn(x, y);
            const off = y * scanlineLen + 1 + x * 3;
            raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
        }
    }
    return Buffer.concat([
        PNG_SIG,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

// --- ffmpeg helpers ---

function metaFlags(title, artist, album, track) {
    return [
        "-metadata", `title=${title}`,
        "-metadata", `artist=${artist}`,
        "-metadata", `album=${album}`,
        "-metadata", `track=${track}`,
        "-metadata", "date=2024",
        "-metadata", "genre=Electronic",
        "-metadata", "comment=e2e fixture",
    ];
}

// transcode a wav Buffer to mp3 + m4a + ogg (opus) with optional metadata
function encodeFormats(wavBuf, stem, extraFlags = []) {
    const wavPath = tmp(".wav");
    writeFileSync(wavPath, wavBuf);
    if (run("ffmpeg", ["-y", "-i", wavPath, "-ar", "44100", "-ac", "1", "-q:a", "5", ...extraFlags, join(OUT, `${stem}.mp3`)])) emit(`${stem}.mp3`);
    if (run("ffmpeg", ["-y", "-i", wavPath, "-ar", "44100", "-ac", "1", "-c:a", "aac", "-b:a", "96k", ...extraFlags, join(OUT, `${stem}.m4a`)])) emit(`${stem}.m4a`);
    // libvorbis not available in this ffmpeg build; use libopus in ogg container
    if (run("ffmpeg", ["-y", "-i", wavPath, "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "64k", ...extraFlags, join(OUT, `${stem}.ogg`)])) emit(`${stem}.ogg`);
}

// ===================== generate =====================

console.log("\naudio (wav, pure node):");
write("tone-440hz-2s.wav", makeWav(2, 440));
write("tone-880hz-5s.wav", makeWav(5, 880));
write("tone-220hz-10s.wav", makeWav(10, 220));
write("chord-stack-3s.wav", makeChordWav(3, [[440, 1], [659.25, 0.8], [554.37, 0.7]])); // A major: A+E+C#
write("tone-stereo-3s.wav", makeWav(3, 440, 2));

console.log("\naudio (encoded, ffmpeg):");

encodeFormats(makeWav(3, 523.25), "tagged-c5-3s", metaFlags("C5 Test Tone", "Fixture Bot", "Test Album", "1"));
encodeFormats(makeWav(4, 220), "tagged-a3-4s", metaFlags("A3 Low Tone", "Fixture Bot", "Test Album", "2"));
encodeFormats(makeWav(6, 349.23), "tagged-f4-6s", metaFlags("F4 Mid Tone", "Another Artist", "Second Album", "1"));
encodeFormats(makeWav(1, 600), "bare-glitch-1s"); // no tags, edge case

{
    const p = tmp(".wav");
    writeFileSync(p, makeWav(8, 80, 2));
    if (run("ffmpeg", ["-y", "-i", p, "-ar", "44100", "-ac", "2", "-q:a", "6",
        "-metadata", "title=Binaural Noise", "-metadata", "artist=Fixture Bot",
        join(OUT, "noisy-binaural-8s.mp3")])) emit("noisy-binaural-8s.mp3");
}

{
    const p = tmp(".wav");
    writeFileSync(p, makeWav(90, 55));
    if (run("ffmpeg", ["-y", "-i", p, "-ar", "22050", "-ac", "1", "-q:a", "9",
        "-metadata", "title=Long Drone", "-metadata", "artist=Fixture Bot",
        join(OUT, "long-drone-90s.mp3")])) emit("long-drone-90s.mp3");
}

console.log("\nimages (png, pure node):");
write("cover-red.png", makePng(128, 128, () => [200, 40, 40]));
write("cover-blue.png", makePng(128, 128, () => [40, 80, 200]));
write("cover-checkers.png", makePng(64, 64, (x, y) => (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? [220, 220, 220] : [30, 30, 30]));
write("cover-noise.png", makePng(256, 256, (x, y) => {
    const h = (n) => ((n * 1664525 + 1013904223) >>> 0) % 256;
    return [h(x * 256 + y), h(x * 256 + y + 65536), h(x * 256 + y + 131072)];
}));

console.log("\nimages (jpg/webp/gif, imagemagick):");

run("magick", ["-size", "400x400", "gradient:#c83232-#3264c8", "-quality", "85", join(OUT, "cover-gradient.jpg")]) && emit("cover-gradient.jpg");
run("magick", ["-size", "300x500", "gradient:#20c820-#c820c8", "-quality", "85", join(OUT, "cover-portrait.jpg")]) && emit("cover-portrait.jpg");
run("magick", ["-size", "48x48", "xc:#ff8800", "-quality", "75", join(OUT, "cover-thumb.jpg")]) && emit("cover-thumb.jpg");
run("magick", ["-size", "256x256", "plasma:", "-quality", "80", join(OUT, "cover-plasma.webp")]) && emit("cover-plasma.webp");
run("magick", ["-size", "600x200", "gradient:#1a1a2e-#e94560", "-quality", "80", join(OUT, "cover-wide.webp")]) && emit("cover-wide.webp");

run("magick", [
    "-delay", "25", "-loop", "0",
    "(", "-size", "80x80", "xc:#ff4444", ")",
    "(", "-size", "80x80", "xc:#44ff44", ")",
    "(", "-size", "80x80", "xc:#4444ff", ")",
    "(", "-size", "80x80", "xc:#ffff44", ")",
    join(OUT, "cover-anim.gif"),
]) && emit("cover-anim.gif");

run("magick", ["-size", "120x120", "radial-gradient:white-black", join(OUT, "cover-mono.gif")]) && emit("cover-mono.gif");

console.log(`\ndone - output: ${OUT}`);
