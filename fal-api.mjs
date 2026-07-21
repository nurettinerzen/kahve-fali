// AI Kahve Falı — backend (fal + falcı sesi)
//
// Sesleri listele:  ELEVENLABS_API_KEY=... node fal-api.mjs --sesler
// Çalıştır:         ANTHROPIC_API_KEY=... ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... node fal-api.mjs
//
// Model: claude-haiku-4-5 (ucuz, varsayılan). Türkçe metin sığ gelirse "claude-sonnet-5".
// Ses: eleven_multilingual_v2 (Türkçe destekli, en iyi kalite). Ucuzlatmak istersen eleven_flash_v2_5.

import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT || 8788;
const MODEL = "claude-haiku-4-5";
const TTS_MODEL = "eleven_multilingual_v2";
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;           // anahtarı ASLA koda yazma
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "wGcFBfKz5yUQqhqr0mVy"; // Hikmet Abla

const client = new Anthropic(); // ANTHROPIC_API_KEY ortam değişkeninden

// ---- production korumaları ----
const APP_KEY = process.env.APP_KEY || "";                 // uygulamanın gönderdiği paylaşılan anahtar
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";          // canlıda kendi alan adını yaz
const MAX_BODY = 8 * 1024 * 1024;                          // 8MB — fotoğraf için fazlasıyla yeter
const LIMITS = { "/api/fal": 20, "/api/ses": 20 };          // IP başına saatlik tavan
const hits = new Map();                                     // ip+yol -> {n, reset}

function limitAsildi(ip, yol) {
  const tavan = LIMITS[yol];
  if (!tavan) return false;
  const now = Date.now(), key = ip + yol;
  const k = hits.get(key);
  if (!k || now > k.reset) { hits.set(key, { n: 1, reset: now + 3600000 }); return false; }
  k.n += 1;
  return k.n > tavan;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 600000).unref();

const SOZLUK = readFileSync(new URL("./fal-sozluk.json", import.meta.url), "utf8");

const SYSTEM = `# Kimlik
Sen Hikmet Abla'sın: deneyimli, biraz gizemli ama içten bir Türk kahve falcısı. Yılların verdiği
tecrübeyle fincandaki sırları çözersin. Samimi, şefkatli ve her zaman umut veren bir yaklaşımın
var. İnsanlara "canım", "güzelim" diye hitap eder, bir abla sıcaklığı verirsin. Gözlemcisin —
fincandaki her detayı fark edersin.

# Ortam
Karşındaki kişi kahvesini içmiş, fincanını kapatmış ve sana fotoğrafını göndermiş; şimdi merakla
yorumunu bekliyor. Sanki karşılıklı kahve içiyormuşsunuz gibi, samimi bir sohbet havası var.
Yazdığın metin sesli okunacak — akıcı, doğal, konuşma dilinde yaz.

# Görev
0) ÖNCE KONTROL ET: Bu fotoğrafta gerçekten kahve telvesi/lekesi olan bir fincan (ya da tabak)
   var mı? Değilse — insan fotoğrafı, manzara, rastgele bir nesne, bomboş temiz fincan ya da
   şekil seçilemeyecek kadar bozuk bir görüntüyse — "fincan_mi" alanını false yap, "uyari"
   alanına Hikmet Abla ağzıyla tek cümlelik tatlı bir uyarı yaz (örn: "Canım bu fotoğrafta
   fincanını göremedim, kahveni içip fincanını kapattıktan sonra içini bir çekiver bana."),
   diğer alanları BOŞ bırak (gorulenler: "", bolumler: [], kapanis: "").
   ASLA fal uydurma. Fincan yoksa fal da yok. Bu kural her şeyin üstünde.

1) Fincan varsa: FİNCANI GERÇEKTEN OKU. Fotoğraftaki gerçek koyu/açık lekelere bakarak 3-4
   somut figür gör (kuş, yol, kalp, balık, yüzük, dağ, göz, ağaç, at, anahtar, gemi, ev,
   merdiven, yıldız...). Her figürün fincanın NERESİNDE olduğunu da söyle (kenara yakın,
   dibinde, sapın yanında...) — çünkü gerçekten baktığını göstermek falın tüm inandırıcılığı.
   Görmediğin şeyi görmüş gibi yapma; 2 figür varsa 2 tanesini söyle.
   Tek cümlede: "Fincanının kenarına yakın bir kuş, dibinden yukarı uzanan bir yol ve sapın
   yanında küçük bir kalp görüyorum güzelim." gibi.
2) Gördüğün figürleri aşağıdaki sembol sözlüğüne göre yorumlayarak dört başlıkta fal bak:
   Aşk, İş & Para, Sağlık & Yaşam, Yakın Gelecek. Her yorum FİNCANDAKİ figürlere dayansın ve
   hangi figürden geldiği anlaşılsın — "şu şekli gördüm, o yüzden şunu söylüyorum" mantığı.
   Herhangi bir fincana yapıştırılabilecek genel geçer laf etme.
3) Kısa ve içten bir hayır dileğiyle kapat.

# Uzunluk
Falın TAMAMI 180-240 kelime olsun (sesli okunduğunda ~1,5 dakika). Her bölüm 2-4 cümle.
Uzatma — dinleyeni yorma.

# Sınırlar
- Asla kesin felaket, ölüm, hastalık teşhisi ya da kesin tarih verme.
- Tıbbi, hukuki, finansal kesin tavsiye yok.
- Korkutma; olumsuzu bile nazikçe söyle ve her zaman bir kapı açık bırak.
- Fincan yoksa ya da şekiller seçilmiyorsa fal UYDURMA — fincan_mi: false ile geri dön.
- Sadece fal bak; başka konuya girme.

# Sembol sözlüğü (şekil → anlam)
${SOZLUK}`;

const SCHEMA = {
  type: "object",
  properties: {
    fincan_mi: { type: "boolean", description: "Fotoğrafta telveli bir fincan var mı" },
    uyari: { type: "string", description: "fincan_mi false ise Hikmet Abla ağzıyla uyarı, değilse boş" },
    gorulenler: { type: "string", description: "Fincanda görülen figürler + yerleri, tek cümle" },
    bolumler: {
      type: "array",
      items: {
        type: "object",
        properties: { baslik: { type: "string" }, metin: { type: "string" } },
        required: ["baslik", "metin"],
        additionalProperties: false,
      },
    },
    kapanis: { type: "string", description: "Kısa bir hayır dileğiyle kapanış" },
  },
  required: ["fincan_mi", "uyari", "gorulenler", "bolumler", "kapanis"],
  additionalProperties: false,
};

// ---- fal ----
async function falBak(imageBase64, mimeType = "image/jpeg") {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: "Bu fincana bak ve falımı söyle." },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });

  if (resp.stop_reason === "refusal") throw new Error("Model isteği reddetti");
  const text = resp.content.find((b) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

// ---- falcı sesi ----
async function seslendir(text) {
  if (!ELEVEN_KEY || !VOICE_ID) throw new Error("ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID yok");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- ses listeleme yardımcısı:  node fal-api.mjs --sesler ----
if (process.argv.includes("--sesler")) {
  if (!ELEVEN_KEY) { console.error("ELEVENLABS_API_KEY lazım."); process.exit(1); }
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } });
  const { voices } = await res.json();
  console.log("\nHesabındaki sesler — falcı için birini seç, voice_id'sini ELEVENLABS_VOICE_ID yap:\n");
  for (const v of voices) {
    const etiket = Object.values(v.labels || {}).join(", ");
    console.log(`  ${v.voice_id}   ${v.name}${etiket ? `  (${etiket})` : ""}`);
  }
  console.log("");
  process.exit(0);
}

// ---- kullanıcı kaydı (Apple ile giriş -> Supabase) ----
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

async function kullaniciKaydet({ apple_sub, email, ad, pazarlama_izni }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase yapılandırılmamış");
  if (!apple_sub) throw new Error("apple_sub zorunlu");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kullanicilar?on_conflict=apple_sub`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ apple_sub, email: email || null, ad: ad || null, pazarlama_izni: Boolean(pazarlama_izni) }]),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// ---- geri bildirim (öneri / şikayet -> Supabase) ----
async function geriBildirimKaydet({ mesaj, email, apple_sub, surum }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase yapılandırılmamış");
  const temiz = String(mesaj || "").trim().slice(0, 2000);
  if (temiz.length < 2) throw new Error("Boş geri bildirim");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/geri_bildirim`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify([{
      mesaj: temiz,
      email: (email || "").trim().slice(0, 200) || null,
      apple_sub: apple_sub || null,
      surum: (surum || "").slice(0, 40) || null,
    }]),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// ---- server ----
async function readBody(req) {
  let body = "", boyut = 0;
  for await (const chunk of req) {
    boyut += chunk.length;
    if (boyut > MAX_BODY) { const e = new Error("Fotoğraf çok büyük"); e.kod = 413; throw e; }
    body += chunk;
  }
  return JSON.parse(body || "{}");
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-app-key");
  if (req.method === "OPTIONS") return res.end();

  if (req.method === "GET" && req.url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, surum: 5, ses: Boolean(ELEVEN_KEY && VOICE_ID) }));
  }

  // politika + destek sayfaları (App Store'un istediği herkese açık URL'ler)
  if (req.method === "GET" && (req.url.startsWith("/gizlilik") || req.url.startsWith("/kullanim") || req.url.startsWith("/destek"))) {
    try {
      const ad = req.url.startsWith("/gizlilik") ? "gizlilik" : req.url.startsWith("/destek") ? "destek" : "kullanim";
      const sayfa = readFileSync(new URL(`./docs/${ad}.html`, import.meta.url));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(sayfa);
    } catch { return res.writeHead(404).end(); }
  }
  if (req.method !== "POST") return res.writeHead(404).end();

  // uygulama anahtarı (APP_KEY tanımlıysa zorunlu) — rastgele kişiler endpoint'i kullanamasın
  if (APP_KEY && req.headers["x-app-key"] !== APP_KEY) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "yetkisiz" }));
  }

  // hız sınırı — kredi yakılmasın
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  const yol = req.url.startsWith("/api/ses") ? "/api/ses" : req.url.startsWith("/api/fal") ? "/api/fal" : "";
  if (limitAsildi(ip, yol)) {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Çok fazla istek, biraz sonra tekrar dene" }));
  }

  try {
    if (req.url.startsWith("/api/fal")) {
      const { image, mimeType } = await readBody(req);
      const fal = await falBak(image, mimeType);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(fal));
    }

    if (req.url.startsWith("/api/kayit")) {
      const govde = await readBody(req);
      await kullaniciKaydet(govde);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.url.startsWith("/api/geribildirim")) {
      const govde = await readBody(req);
      await geriBildirimKaydet(govde);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.url.startsWith("/api/ses")) {
      const { text } = await readBody(req);
      const audio = await seslendir(text);
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length });
      return res.end(audio);
    }

    res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => {
  console.log(`Fal API  → http://localhost:${PORT}/api/fal`);
  console.log(`Falcı sesi → ${ELEVEN_KEY && VOICE_ID ? "bağlı (" + TTS_MODEL + ")" : "KAPALI — anahtar yok, tarayıcı sesine düşecek"}`);
});
