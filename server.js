/**
 * Personal Video Downloader — Learning Project (Local Use Only)
 * ---------------------------------------------------------------
 * Uses yt-dlp (must be installed separately) as a backend engine.
 * Intended ONLY for content you own or have rights to download
 * (your own uploads, Creative Commons videos, public domain, etc).
 *
 * Run locally with: node server.js
 * Then open: http://localhost:3000
 */

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Tracks in-progress downloads so they can be cancelled: id -> child process
const activeDownloads = new Map();

// --- Get available formats/qualities for a URL ---
app.post("/api/formats", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const ytdlp = spawn("yt-dlp", ["-F", url]);
  let output = "";
  let errorOutput = "";

  ytdlp.stdout.on("data", (data) => (output += data.toString()));
  ytdlp.stderr.on("data", (data) => (errorOutput += data.toString()));

  ytdlp.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: errorOutput || "yt-dlp failed" });
    }
    res.json({ raw: output });
  });
});

// --- Start a download, streaming progress via Server-Sent Events ---
app.get("/api/download", (req, res) => {
  const { url, quality, id } = req.query;
  if (!url) return res.status(400).send("URL is required");
  if (!id) return res.status(400).send("id is required");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s");
  const formatArg = quality && quality !== "best" ? quality : "bv*+ba/best";

  const args = [
    "-f", formatArg,
    "--merge-output-format", "mp4",
    "-o", outputTemplate,
    "--newline",
    url,
  ];

  const ytdlp = spawn("yt-dlp", args);
  activeDownloads.set(id, ytdlp);

  let finalFile = null;
  let cancelled = false;
  // If yt-dlp goes quiet for a while after the last "download" progress
  // line (usually because it's merging audio+video with ffmpeg), let the
  // UI know it's still working instead of looking stuck at 100%.
  let mergeTimer = null;
  const flagMerging = () => {
    res.write(`data: ${JSON.stringify({ stage: "merging" })}\n\n`);
  };

  ytdlp.stdout.on("data", (data) => {
    const text = data.toString();

    const match = text.match(/\[download\]\s+([\d.]+)%/);
    if (match) {
      res.write(`data: ${JSON.stringify({ progress: match[1] })}\n\n`);
      if (parseFloat(match[1]) >= 100) {
        clearTimeout(mergeTimer);
        mergeTimer = setTimeout(flagMerging, 1200);
      }
    }

    const destMatch = text.match(/\[download\] Destination: (.+)/);
    if (destMatch) finalFile = destMatch[1].trim();

    const mergeMatch = text.match(/\[Merger\] Merging formats into "(.+)"/);
    if (mergeMatch) {
      finalFile = mergeMatch[1].trim();
      flagMerging();
    }
  });

  ytdlp.stderr.on("data", (data) => {
    res.write(`data: ${JSON.stringify({ log: data.toString() })}\n\n`);
  });

  ytdlp.on("error", (err) => {
    // e.g. yt-dlp binary not found / not on PATH
    clearTimeout(mergeTimer);
    res.write(
      `data: ${JSON.stringify({
        error: "yt-dlp চালানো যায়নি: " + err.message,
      })}\n\n`
    );
    res.end();
    activeDownloads.delete(id);
  });

  ytdlp.on("close", (code) => {
    clearTimeout(mergeTimer);
    activeDownloads.delete(id);
    if (cancelled) {
      res.write(`data: ${JSON.stringify({ cancelled: true })}\n\n`);
    } else if (code === 0) {
      res.write(
        `data: ${JSON.stringify({
          done: true,
          file: finalFile ? path.basename(finalFile) : null,
        })}\n\n`
      );
    } else {
      res.write(`data: ${JSON.stringify({ error: "Download failed" })}\n\n`);
    }
    res.end();
  });

  req.on("close", () => {
    if (activeDownloads.has(id)) {
      cancelled = true;
      ytdlp.kill();
    }
  });
});

// --- Cancel an in-progress download ---
app.post("/api/cancel/:id", (req, res) => {
  const proc = activeDownloads.get(req.params.id);
  if (!proc) return res.status(404).json({ ok: false });
  proc.kill();
  activeDownloads.delete(req.params.id);
  res.json({ ok: true });
});

// --- List downloaded files ---
app.get("/api/files", (req, res) => {
  const files = fs.readdirSync(DOWNLOAD_DIR);
  res.json({ files });
});

// --- Serve/download a finished file ---
app.get("/api/file/:name", (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`\n✅ Server running: http://localhost:${PORT}`);
  console.log(`📁 Downloads saved to: ${DOWNLOAD_DIR}\n`);
});