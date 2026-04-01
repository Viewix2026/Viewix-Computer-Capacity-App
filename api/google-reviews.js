// Vercel Serverless Function: Google Reviews
// Fetches live rating and review count from Google Places API

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const API_KEY = "AIzaSyAREwLzVUPhilGZaIqv2udcgDe981WBU8o";
  const PLACE_ID = "ChIJ87p3vJ9QRAIRRkX7FtSsJTo";

  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${PLACE_ID}&fields=rating,user_ratings_total,name&key=${API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data?.result) {
      return res.status(200).json({
        rating: data.result.rating || 0,
        reviewCount: data.result.user_ratings_total || 0,
        name: data.result.name || "Viewix",
        source: "live"
      });
    }

    return res.status(200).json({ rating: 5.0, reviewCount: 57, source: "fallback", error: data?.error_message });
  } catch (e) {
    console.error("Google Places API error:", e);
    return res.status(200).json({ rating: 5.0, reviewCount: 57, source: "fallback" });
  }
}
