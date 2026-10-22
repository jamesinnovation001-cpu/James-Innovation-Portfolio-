import { list, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";

const MAX_BODY = 8_000;
const recent = new Map();

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function clean(value, max) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function rateLimited(key) {
  const now = Date.now();
  const prior = recent.get(key) || [];
  const active = prior.filter(t => now - t < 10 * 60 * 1000);
  if (active.length >= 4) return true;
  active.push(now);
  recent.set(key, active);
  if (recent.size > 5000) {
    for (const [k, times] of recent) if (!times.some(t => now - t < 10 * 60 * 1000)) recent.delete(k);
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return json(res, 503, { error: "Review storage is not configured yet." });
    try {
      const { blobs } = await list({ prefix: "reviews/", token: process.env.BLOB_READ_WRITE_TOKEN });
      const reviews = [];
      for (const blob of blobs.slice(0, 200)) {
        try {
          const response = await fetch(blob.url, { cache: "no-store" });
          if (!response.ok) continue;
          const item = await response.json();
          if (item && item.name && item.business && item.message && Number(item.rating) >= 1 && Number(item.rating) <= 5) reviews.push(item);
        } catch {}
      }
      reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return json(res, 200, { reviews });
    } catch (error) {
      return json(res, 500, { error: "Could not load reviews right now." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Method not allowed." });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) return json(res, 503, { error: "Review storage is not configured yet." });

  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ipKey = forwarded || "unknown";
  if (rateLimited(ipKey)) return json(res, 429, { error: "Too many submissions. Please try again in 10 minutes." });

  try {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return json(res, 413, { error: "Review is too large." });
    }
    const input = JSON.parse(raw || "{}");

    if (clean(input.website, 200)) return json(res, 400, { error: "Invalid submission." });
    if (!Number.isFinite(Number(input.formStarted)) || Date.now() - Number(input.formStarted) < 2500) {
      return json(res, 400, { error: "Please take a moment to complete the form and try again." });
    }

    const name = clean(input.name, 80);
    const business = clean(input.business, 100);
    const message = String(input.message ?? "").trim().replace(/\r/g, "");
    const rating = Number(input.rating);
    if (name.length < 2 || business.length < 2) return json(res, 400, { error: "Please enter your name and business name." });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(res, 400, { error: "Please choose a rating from 1 to 5." });
    if (message.length < 10 || message.length > 1200) return json(res, 400, { error: "Your review must be between 10 and 1,200 characters." });
    if (/[<>]/.test(name + business)) return json(res, 400, { error: "Please remove unsupported characters from your name or business name." });

    const review = { id: randomUUID(), name, business, rating, message, createdAt: new Date().toISOString() };
    await put("reviews/" + review.id + ".json", JSON.stringify(review), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json; charset=utf-8",
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    return json(res, 201, { review });
  } catch (error) {
    return json(res, 500, { error: "We couldn't save your review. Please try again shortly." });
  }
}
