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
import { createPublicKey, createVerify, randomBytes } from "node:crypto";

const PORT = process.env.PORT || 8788;
const MODEL = "claude-haiku-4-5";
const TTS_MODEL = "eleven_multilingual_v2";
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;           // anahtarı ASLA koda yazma
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "wGcFBfKz5yUQqhqr0mVy"; // Hikmet Abla

const client = new Anthropic(); // ANTHROPIC_API_KEY ortam değişkeninden

// ---- production korumaları ----
const APP_KEY = process.env.APP_KEY || "";                 // uygulamanın gönderdiği paylaşılan anahtar
// CORS: ALLOWED_ORIGIN yoksa "*" verme — yalnızca native WebView origin'lerine izin ver.
// (Capacitor iOS varsayılanı capacitor://localhost; native fetch çoğu zaman Origin bile göndermez.)
const ORIGIN = process.env.ALLOWED_ORIGIN || "";
const IZINLI_ORIGIN = new Set([
  "capacitor://localhost", "ionic://localhost",
  "http://localhost", "http://localhost:8100", "http://localhost:5173", "http://localhost:8788",
].concat(ORIGIN && ORIGIN !== "*" ? ORIGIN.split(",").map((s) => s.trim()).filter(Boolean) : []));

function corsUygula(req, res) {
  const gelen = req.headers.origin;
  if (ORIGIN === "*") { res.setHeader("Access-Control-Allow-Origin", "*"); }
  else if (gelen && IZINLI_ORIGIN.has(gelen)) {
    res.setHeader("Access-Control-Allow-Origin", gelen);
    res.setHeader("Vary", "Origin");
  }
  // Origin yoksa (native/curl) CORS başlığına gerek yok; tarayıcı dışı istekler zaten etkilenmez.
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-app-key");
  res.setHeader("Access-Control-Expose-Headers", "x-bakiye");   // /api/ses bakiyeyi başlıkta döndürüyor
}
const MAX_BODY = 8 * 1024 * 1024;                          // 8MB — fotoğraf için fazlasıyla yeter
const MAX_IMAGE_B64 = 7 * 1024 * 1024;                     // tek fotoğrafın base64 üst sınırı
const MAX_SES_KARAKTER = 3000;                             // ElevenLabs karakter başına ücretlendirir — fatura tavanı
// IP başına saatlik tavan. HER POST ucu burada olmalı; olmayan uç sınırsız kalır.
const LIMITS = {
  "/api/fal": 20, "/api/ses": 20, "/api/kayit": 30, "/api/geribildirim": 10, "/api/hesap-sil": 10,
  "/api/oturum": 60, "/api/satinalma": 30,
};

// ---- jeton defteri yapılandırması ----
const BEDAVA_HAK = 1;                                      // istemcideki BEDAVA_HAK ile aynı olmalı
const GIRIS_HEDIYE = 1;                                    // Apple ile ilk girişte verilen jeton
const DEVIR_TAVAN = 50;                                    // eski sürümden taşınabilecek en fazla jeton
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || "com.nurettinerzen.kahvefali";
const RC_SECRET = process.env.RC_SECRET || "";             // RevenueCat > API keys > Secret (sk_...)
// Geçiş anahtarı: mağazadaki ESKİ sürüm /api/hesap-sil'e kimlik jetonu göndermiyor.
// Yeni sürüm yayına girene kadar "1" bırak, sonra KALDIR (IDOR ancak o zaman tamamen kapanır).
const HESAPSIL_ESKI_ISTEMCI = process.env.HESAPSIL_ESKI_ISTEMCI === "1";
const JETON_URUN = { jeton_1: 1, jeton_5: 5, jeton_20: 20 };
// Test kancası: SADECE TEST_SUNUCU=1 iken dış servisler yerel taklitlere yönlendirilebilir.
// Üretimde bu değişken tanımsızdır; adresler sabit kalır.
const TEST = process.env.TEST_SUNUCU === "1";
const APPLE_JWKS = (TEST && process.env.TEST_APPLE_JWKS) || "https://appleid.apple.com/auth/keys";
const RC_BASE = (TEST && process.env.TEST_RC_BASE) || "https://api.revenuecat.com";
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
const IZINLI_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function falBak(imageBase64, mimeType = "image/jpeg") {
  // girdi doğrulama — bozuk istek Anthropic'e gidip boşuna para yakmasın
  if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
    const e = new Error("Fotoğraf gelmedi"); e.kod = 400; throw e;
  }
  if (imageBase64.length > MAX_IMAGE_B64) {
    const e = new Error("Fotoğraf çok büyük"); e.kod = 413; throw e;
  }
  // Anthropic yalnızca bu türleri kabul eder; HEIC gibi türleri jpeg sanıp denemek yerine net hata ver
  if (!IZINLI_MIME.has(mimeType)) {
    const e = new Error("Desteklenmeyen fotoğraf türü"); e.kod = 400; throw e;
  }
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
  // ElevenLabs karakter başına ücretlendirir: sınırsız metin = sınırsız fatura
  const temiz = String(text ?? "").trim();
  if (temiz.length < 10) { const e = new Error("Seslendirilecek metin yok"); e.kod = 400; throw e; }
  if (temiz.length > MAX_SES_KARAKTER) { const e = new Error("Metin çok uzun"); e.kod = 413; throw e; }
  text = temiz;
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

// ============================================================================
// Apple kimlik jetonu doğrulama (imza + iss/aud/exp)
// Bağımlılık eklemedik: Apple'ın JWKS'i JWK biçiminde geliyor, node:crypto bunu
// doğrudan okuyabiliyor (createPublicKey format:"jwk"), imza RS256.
// ============================================================================
let appleAnahtarlar = { veri: null, sure: 0 };

async function appleAnahtarAl(kid) {
  const simdi = Date.now();
  if (!appleAnahtarlar.veri || simdi > appleAnahtarlar.sure) {
    const r = await fetch(APPLE_JWKS);
    if (!r.ok) throw new Error(`Apple JWKS ${r.status}`);
    const j = await r.json();
    appleAnahtarlar = { veri: j.keys || [], sure: simdi + 12 * 3600 * 1000 };
  }
  let k = appleAnahtarlar.veri.find((x) => x.kid === kid);
  if (!k) {                                   // anahtar döndürülmüş olabilir: önbelleği bir kez tazele
    appleAnahtarlar.sure = 0;
    const r = await fetch(APPLE_JWKS);
    if (r.ok) { const j = await r.json(); appleAnahtarlar = { veri: j.keys || [], sure: simdi + 12 * 3600 * 1000 }; }
    k = appleAnahtarlar.veri.find((x) => x.kid === kid);
  }
  return k || null;
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Geçerliyse Apple kullanıcı kimliğini (sub) döndürür; değilse 401 fırlatır.
async function appleSubDogrula(token) {
  const yetkisiz = (neden) => { const e = new Error("Apple kimliği doğrulanamadı"); e.kod = 401; e.neden = neden; return e; };
  if (typeof token !== "string" || token.split(".").length !== 3) throw yetkisiz("bicim");
  const [h64, p64, s64] = token.split(".");
  let baslik, govde;
  try { baslik = JSON.parse(b64url(h64).toString("utf8")); govde = JSON.parse(b64url(p64).toString("utf8")); }
  catch { throw yetkisiz("cozulemedi"); }
  if (baslik.alg !== "RS256") throw yetkisiz("alg");        // "none"/HS256 karıştırma saldırısına kapı bırakma
  const jwk = await appleAnahtarAl(baslik.kid);
  if (!jwk) throw yetkisiz("kid");
  const anahtar = createPublicKey({ key: jwk, format: "jwk" });
  const dogrulayici = createVerify("RSA-SHA256");
  dogrulayici.update(`${h64}.${p64}`);
  if (!dogrulayici.verify(anahtar, b64url(s64))) throw yetkisiz("imza");
  if (govde.iss !== "https://appleid.apple.com") throw yetkisiz("iss");
  const aud = Array.isArray(govde.aud) ? govde.aud : [govde.aud];
  if (!aud.includes(APPLE_CLIENT_ID)) throw yetkisiz("aud");
  const simdi = Math.floor(Date.now() / 1000);
  if (!govde.exp || govde.exp + 60 < simdi) throw yetkisiz("exp");   // 60sn saat kayması payı
  if (!govde.sub) throw yetkisiz("sub");
  return String(govde.sub);
}

// ============================================================================
// Jeton defteri (Supabase) — otorite sunucu
//
// Supabase > SQL Editor'da BİR KEZ çalıştır (sunucuyu yayına almadan ÖNCE):
//
//   create table if not exists jeton_bakiye (
//     kimlik            text primary key,          -- "apple:<sub>" ya da "cihaz:<uuid>"
//     jeton             integer not null default 0,
//     bedava_kullanilan integer not null default 0,
//     apple_sub         text,
//     cihaz             text,                      -- RevenueCat app_user_id
//     oturum            text unique,               -- istemcinin taşıdığı gizli oturum jetonu
//     olusturma         timestamptz not null default now(),
//     guncelleme        timestamptz not null default now()
//   );
//   create index if not exists jeton_bakiye_oturum_idx on jeton_bakiye (oturum);
//   create index if not exists jeton_bakiye_apple_idx  on jeton_bakiye (apple_sub);
//
//   create table if not exists jeton_islem (
//     islem_id   text primary key,                 -- "rc:<store_transaction_id>" — MÜKERRER ENGELİ
//     kimlik     text not null,
//     urun       text,
//     jeton      integer not null,
//     olusturma  timestamptz not null default now()
//   );
//   create index if not exists jeton_islem_kimlik_idx on jeton_islem (kimlik);
//
//   -- Bu tablolara yalnızca service_role erişir; anon anahtarına AÇMA:
//   alter table jeton_bakiye enable row level security;
//   alter table jeton_islem  enable row level security;
//
// Not: jeton düşme/ekleme iyimser kilitle (CAS) yapılır — PATCH filtresi okunan değeri
// içerir, satır değişmişse 0 satır döner ve işlem yeniden denenir.
// ============================================================================
const sbBaslik = (ek = {}) => ({
  apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, "content-type": "application/json", ...ek,
});
const defterAcik = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

async function sbIstek(yol, secenek = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${yol}`, secenek);
  if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${await r.text()}`); e.sb = r.status; throw e; }
  const metin = await r.text();
  return metin ? JSON.parse(metin) : null;
}

const yeniOturum = () => randomBytes(24).toString("hex");
const temizId = (v, uz = 64) => {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9._:-]{8,}$/.test(s) && s.length <= uz ? s : null;
};

async function hesapOturumdan(oturum) {
  if (!defterAcik() || !oturum) return null;
  const satir = await sbIstek(`jeton_bakiye?oturum=eq.${encodeURIComponent(oturum)}&select=*&limit=1`, { headers: sbBaslik() });
  return (satir && satir[0]) || null;
}

async function hesapKimlikten(kimlik) {
  if (!defterAcik() || !kimlik) return null;
  const satir = await sbIstek(`jeton_bakiye?kimlik=eq.${encodeURIComponent(kimlik)}&select=*&limit=1`, { headers: sbBaslik() });
  return (satir && satir[0]) || null;
}

async function hesapYaz(kimlik, alanlar) {
  return sbIstek(`jeton_bakiye?kimlik=eq.${encodeURIComponent(kimlik)}`, {
    method: "PATCH",
    headers: sbBaslik({ prefer: "return=representation" }),
    body: JSON.stringify({ ...alanlar, guncelleme: new Date().toISOString() }),
  });
}

async function hesapOlustur(kimlik, alanlar) {
  const oturum = yeniOturum();
  await sbIstek("jeton_bakiye?on_conflict=kimlik", {
    method: "POST",
    headers: sbBaslik({ prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{ kimlik, jeton: 0, bedava_kullanilan: 0, oturum, ...alanlar }]),
  });
  return hesapKimlikten(kimlik);
}

// İyimser kilit (CAS): okuduğumuz değer hâlâ aynıysa yaz. Aynı anda iki istek gelirse
// biri boşa döner ve yeniden dener — böylece tek jetonla iki fal bakılamaz.
async function jetonHarca(hesap, tur) {
  for (let deneme = 0; deneme < 4; deneme++) {
    const h = deneme === 0 ? hesap : await hesapKimlikten(hesap.kimlik);
    if (!h) return { ok: false, sebep: "hesap-yok" };
    const bedavaVar = tur === "fal" && (h.bedava_kullanilan || 0) < BEDAVA_HAK;
    if (!bedavaVar && (h.jeton || 0) < 1) return { ok: false, sebep: "bakiye" };
    const alan = bedavaVar ? "bedava_kullanilan" : "jeton";
    const eski = h[alan] || 0;
    const yeni = bedavaVar ? eski + 1 : eski - 1;
    const sonuc = await sbIstek(
      `jeton_bakiye?kimlik=eq.${encodeURIComponent(h.kimlik)}&${alan}=eq.${eski}`,
      { method: "PATCH", headers: sbBaslik({ prefer: "return=representation" }), body: JSON.stringify({ [alan]: yeni, guncelleme: new Date().toISOString() }) },
    );
    if (sonuc && sonuc[0]) return { ok: true, alan, hesap: sonuc[0] };
  }
  return { ok: false, sebep: "cakisma" };
}

// Fal/ses üretilemezse harcanan hakkı geri ver (kullanıcı boşa ödemesin).
async function jetonIade(kimlik, alan) {
  try {
    for (let deneme = 0; deneme < 4; deneme++) {
      const h = await hesapKimlikten(kimlik);
      if (!h) return;
      const eski = h[alan] || 0;
      const yeni = alan === "bedava_kullanilan" ? Math.max(0, eski - 1) : eski + 1;
      const sonuc = await sbIstek(
        `jeton_bakiye?kimlik=eq.${encodeURIComponent(kimlik)}&${alan}=eq.${eski}`,
        { method: "PATCH", headers: sbBaslik({ prefer: "return=representation" }), body: JSON.stringify({ [alan]: yeni, guncelleme: new Date().toISOString() }) },
      );
      if (sonuc && sonuc[0]) return;
    }
  } catch (e) { console.error("jeton iadesi başarısız", kimlik, alan, e && e.message); }
}

// islem_id birincil anahtar: aynı satın alma iki kez jeton yükleyemez.
async function islemIsle(islem_id, kimlik, urun, adet) {
  try {
    await sbIstek("jeton_islem", {
      method: "POST",
      headers: sbBaslik({ prefer: "return=minimal" }),
      body: JSON.stringify([{ islem_id, kimlik, urun: urun || null, jeton: adet }]),
    });
  } catch (e) {
    if (e.sb === 409) return false;                     // zaten yüklenmiş — mükerrer
    throw e;
  }
  for (let deneme = 0; deneme < 5; deneme++) {
    const h = await hesapKimlikten(kimlik);
    if (!h) return false;
    const eski = h.jeton || 0;
    const sonuc = await sbIstek(
      `jeton_bakiye?kimlik=eq.${encodeURIComponent(kimlik)}&jeton=eq.${eski}`,
      { method: "PATCH", headers: sbBaslik({ prefer: "return=representation" }), body: JSON.stringify({ jeton: eski + adet, guncelleme: new Date().toISOString() }) },
    );
    if (sonuc && sonuc[0]) return true;
  }
  // Jeton yazılamadı: islem kaydını geri al ki istemci tekrar denediğinde yüklenebilsin
  await sbIstek(`jeton_islem?islem_id=eq.${encodeURIComponent(islem_id)}`, { method: "DELETE", headers: sbBaslik({ prefer: "return=minimal" }) }).catch(() => {});
  throw new Error("jeton yazılamadı");
}

const bakiyeOzet = (h) => ({
  jeton: h.jeton || 0,
  bedava_kullanilan: h.bedava_kullanilan || 0,
  bedava_hak: BEDAVA_HAK,
});

// ---- /api/oturum: kimlik çözümle, oturum jetonu ver, bakiyeyi döndür ----
async function oturumAc({ cihaz, apple_token, devir_jeton, devir_bedava, oturum }) {
  if (!defterAcik()) { const e = new Error("Defter kapalı"); e.kod = 503; throw e; }
  const cihazId = temizId(cihaz);
  let apple_sub = null;
  if (apple_token) apple_sub = await appleSubDogrula(apple_token);   // geçersizse 401 fırlatır

  // Elde geçerli bir oturum varsa ONA bağlı hesabı kullan: Apple ile giriş yapmış kullanıcı
  // uygulamayı yeniden açtığında cihaz hesabına düşmesin (bakiyesi orada değil).
  let h = null;
  if (!apple_sub && oturum) h = await hesapOturumdan(oturum).catch(() => null);

  const kimlik = h ? h.kimlik : (apple_sub ? `apple:${apple_sub}` : (cihazId ? `cihaz:${cihazId}` : null));
  if (!kimlik) { const e = new Error("Kimlik gerekli"); e.kod = 400; throw e; }

  if (!h) h = await hesapKimlikten(kimlik);
  if (!h) {
    // Yeni hesap. Eski sürümden gelen kullanıcı: yerel bakiyesini bir kereliğine devret
    // (satın aldığı jetonlar sunucuya geçerken buharlaşmasın).
    const dj = Math.min(DEVIR_TAVAN, Math.max(0, parseInt(devir_jeton, 10) || 0));
    const db = Math.min(BEDAVA_HAK, Math.max(0, parseInt(devir_bedava, 10) || 0));
    h = await hesapOlustur(kimlik, { jeton: dj, bedava_kullanilan: db, apple_sub, cihaz: cihazId });
    if (dj) await sbIstek("jeton_islem", {
      method: "POST", headers: sbBaslik({ prefer: "return=minimal" }),
      body: JSON.stringify([{ islem_id: `devir:${kimlik}`, kimlik, urun: "devir", jeton: dj }]),
    }).catch(() => {});
  }
  if (!h) { const e = new Error("Hesap açılamadı"); e.kod = 503; throw e; }

  const yama = {};
  if (cihazId && h.cihaz !== cihazId) yama.cihaz = cihazId;          // RevenueCat kullanıcı kimliği bu cihaz
  if (apple_sub && h.apple_sub !== apple_sub) yama.apple_sub = apple_sub;
  if (!h.oturum) yama.oturum = yeniOturum();
  if (Object.keys(yama).length) { const y = await hesapYaz(kimlik, yama); if (y && y[0]) h = y[0]; }

  // Apple ile ilk giriş hediyesi: islem kaydıyla ömür boyu bir kez (silip kurmak yeniden kazandırmaz)
  if (apple_sub && GIRIS_HEDIYE > 0) {
    try { await islemIsle(`giris:${apple_sub}`, kimlik, "giris_hediye", GIRIS_HEDIYE); h = (await hesapKimlikten(kimlik)) || h; }
    catch (e) { console.error("giriş hediyesi", e && e.message); }
  }

  // Cihaz hesabındaki bakiyeyi Apple hesabına taşı (giriş yapınca jetonları kaybetmesin)
  if (apple_sub && cihazId) {
    const eski = await hesapKimlikten(`cihaz:${cihazId}`);
    if (eski && (eski.jeton || 0) > 0) {
      try {
        // ÖNCE cihaz hesabını CAS ile sıfırla: yazamazsak jeton kopyalanmış olmaz
        const bosalt = await sbIstek(
          `jeton_bakiye?kimlik=eq.${encodeURIComponent(eski.kimlik)}&jeton=eq.${eski.jeton}`,
          { method: "PATCH", headers: sbBaslik({ prefer: "return=representation" }), body: JSON.stringify({ jeton: 0, guncelleme: new Date().toISOString() }) },
        );
        if (bosalt && bosalt[0]) {
          await islemIsle(`birlestir:cihaz:${cihazId}:${eski.jeton}`, kimlik, "birlestirme", eski.jeton);
          h = (await hesapKimlikten(kimlik)) || h;
        }
      } catch (e) { console.error("hesap birleştirme", e && e.message); }
    }
  }
  return { oturum: h.oturum, kimlik: h.kimlik, apple_bagli: Boolean(h.apple_sub), ...bakiyeOzet(h) };
}

// ---- /api/satinalma: RevenueCat'ten DOĞRULA, sonra jeton yükle ----
async function satinAlmaSenkron({ oturum, rc_uid }) {
  if (!defterAcik()) { const e = new Error("Defter kapalı"); e.kod = 503; throw e; }
  if (!RC_SECRET) { const e = new Error("Mağaza doğrulaması yapılandırılmamış"); e.kod = 503; throw e; }
  const h = await hesapOturumdan(oturum);
  if (!h) { const e = new Error("Oturum geçersiz"); e.kod = 401; throw e; }
  const uid = temizId(rc_uid);
  if (!uid) { const e = new Error("rc_uid gerekli"); e.kod = 400; throw e; }
  // Başkasının satın almasını üstlenmeyi engelle: rc_uid hesabın son cihazı olmalı
  if (h.cihaz && h.cihaz !== uid) { const e = new Error("Cihaz eşleşmedi"); e.kod = 403; throw e; }

  const r = await fetch(`${RC_BASE}/v1/subscribers/${encodeURIComponent(uid)}`, {
    headers: { authorization: `Bearer ${RC_SECRET}`, accept: "application/json" },
  });
  if (!r.ok) { const e = new Error("Mağaza doğrulaması başarısız"); e.kod = 502; console.error("RC", r.status, await r.text()); throw e; }
  const { subscriber } = await r.json();
  const tuketilebilir = (subscriber && subscriber.non_subscriptions) || {};

  let eklenen = 0;
  const oncekiSahipler = new Set();
  for (const [urun, islemler] of Object.entries(tuketilebilir)) {
    const adet = JETON_URUN[urun];
    if (!adet || !Array.isArray(islemler)) continue;      // tanımadığımız ürüne jeton yazma
    for (const it of islemler) {
      const islem_id = String(it.store_transaction_id || it.id || "").slice(0, 120);
      if (!islem_id) continue;
      try {
        if (await islemIsle(`rc:${islem_id}`, h.kimlik, urun, adet)) { eklenen += adet; continue; }
        // Mükerrer: bu alım daha önce BAŞKA bir kimliğe yüklenmiş olabilir
        const eskiKayit = await sbIstek(`jeton_islem?islem_id=eq.${encodeURIComponent("rc:" + islem_id)}&select=kimlik`, { headers: sbBaslik() });
        const sahip = eskiKayit && eskiKayit[0] && eskiKayit[0].kimlik;
        if (sahip && sahip !== h.kimlik && sahip.startsWith("cihaz:")) oncekiSahipler.add(sahip);
      } catch (e) { console.error("islem yüklenemedi", islem_id, e && e.message); }
    }
  }

  // Uygulama silinip yeniden kurulduğunda cihaz kimliği değişir ve yeni hesap boş açılır.
  // Apple makbuzu (RevenueCat restore ile) artık BU kullanıcıda olduğuna göre, eski anonim
  // cihaz hesabının KALAN bakiyesi de bu kullanıcıya aittir — taşı.
  // Yalnızca "cihaz:" hesapları taşınır; "apple:" hesabına Apple ile giriş yapılarak erişilir.
  for (const eskiKimlik of oncekiSahipler) {
    try {
      const eski = await hesapKimlikten(eskiKimlik);
      if (!eski || (eski.jeton || 0) < 1) continue;
      const bosalt = await sbIstek(
        `jeton_bakiye?kimlik=eq.${encodeURIComponent(eskiKimlik)}&jeton=eq.${eski.jeton}`,
        { method: "PATCH", headers: sbBaslik({ prefer: "return=representation" }), body: JSON.stringify({ jeton: 0, guncelleme: new Date().toISOString() }) },
      );
      if (!bosalt || !bosalt[0]) continue;
      if (await islemIsle(`tasima:${eskiKimlik}:${eski.jeton}:${h.kimlik}`, h.kimlik, "tasima", eski.jeton)) eklenen += eski.jeton;
    } catch (e) { console.error("bakiye taşınamadı", eskiKimlik, e && e.message); }
  }

  const son = (await hesapKimlikten(h.kimlik)) || h;
  return { eklenen, ...bakiyeOzet(son) };
}

// Ücretli uçlarda ortak: oturumu çöz, hakkı düş. Oturum yoksa ESKİ davranış (istemci otoritesi).
async function hakDus(govde, tur) {
  const oturum = govde && typeof govde.oturum === "string" ? govde.oturum : null;
  if (!oturum || !defterAcik()) return { uygulandi: false };        // eski istemci — kırma
  let h;
  try { h = await hesapOturumdan(oturum); }
  catch (e) { console.error("defter okunamadı", e && e.message); return { uygulandi: false }; }  // defter arızası hizmeti durdurmasın
  if (!h) { const e = new Error("Oturum geçersiz"); e.kod = 401; throw e; }
  const d = await jetonHarca(h, tur);
  if (!d.ok) {
    const e = new Error(d.sebep === "bakiye" ? "Jetonun kalmadı" : "Şu an işlenemedi, tekrar dene");
    e.kod = d.sebep === "bakiye" ? 402 : 409;
    throw e;
  }
  return { uygulandi: true, kimlik: h.kimlik, alan: d.alan, bakiye: bakiyeOzet(d.hesap) };
}

async function kullaniciKaydet({ apple_sub, email, ad, pazarlama_izni, apple_token }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase yapılandırılmamış");
  // Kimlik jetonu geldiyse apple_sub'ı ONDAN al: istemcinin yazdığı sub'a güvenilmez
  // (aksi hâlde başkasının kaydındaki e-posta/ad üzerine yazılabilirdi).
  // Jeton yoksa eski davranış korunur — mağazadaki eski sürüm kırılmasın.
  if (apple_token) apple_sub = await appleSubDogrula(apple_token);
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

// ---- hesap silme (Apple 5.1.1(v): hesap açan uygulama silme de sunmalı) ----
// SAHİPLİK ZORUNLU: apple_sub'ı gövdeden okuyup silmek IDOR'du (APP_KEY'i olan herkes
// başkasının hesabını silebiliyordu). Artık kimlik ya taze Apple jetonundan ya da
// hesaba bağlı oturum jetonundan çözülüyor; istemcinin yazdığı apple_sub'a GÜVENİLMİYOR.
async function hesapSil(govde) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase yapılandırılmamış");
  let apple_sub = null;
  let kimlik = null;

  if (govde && govde.apple_token) {
    apple_sub = await appleSubDogrula(govde.apple_token);        // imza + iss/aud/exp
    kimlik = `apple:${apple_sub}`;
  } else if (govde && govde.oturum) {
    const h = await hesapOturumdan(govde.oturum);
    if (!h) { const e = new Error("Oturum geçersiz"); e.kod = 401; throw e; }
    apple_sub = h.apple_sub || null;
    kimlik = h.kimlik;
  } else if (HESAPSIL_ESKI_ISTEMCI && govde && govde.apple_sub) {
    // GEÇİCİ: mağazadaki eski sürüm kimlik jetonu göndermiyor. Yeni sürüm yayına
    // girdikten sonra HESAPSIL_ESKI_ISTEMCI ortam değişkenini KALDIR.
    apple_sub = String(govde.apple_sub);
    kimlik = `apple:${apple_sub}`;
    console.warn("hesap-sil: doğrulanmamış eski istemci yolu kullanıldı");
  } else {
    const e = new Error("Kimlik doğrulaması gerekli"); e.kod = 401; throw e;
  }

  const bas = { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, prefer: "return=minimal" };
  if (apple_sub) {
    const q = `apple_sub=eq.${encodeURIComponent(apple_sub)}`;
    const r1 = await fetch(`${SUPABASE_URL}/rest/v1/kullanicilar?${q}`, { method: "DELETE", headers: bas });
    if (!r1.ok) throw new Error(`Supabase ${r1.status}: ${await r1.text()}`);
    await fetch(`${SUPABASE_URL}/rest/v1/geri_bildirim?${q}`, { method: "DELETE", headers: bas }).catch(() => {});
  }
  // jeton defterindeki kaydı da sil (kalan bakiye de gider — silme onayında yazıyor)
  if (kimlik) {
    const jq = `kimlik=eq.${encodeURIComponent(kimlik)}`;
    await fetch(`${SUPABASE_URL}/rest/v1/jeton_islem?${jq}`, { method: "DELETE", headers: bas }).catch(() => {});
    await fetch(`${SUPABASE_URL}/rest/v1/jeton_bakiye?${jq}`, { method: "DELETE", headers: bas }).catch(() => {});
  }
}

// ---- server ----
async function readBody(req) {
  let body = "", boyut = 0;
  for await (const chunk of req) {
    boyut += chunk.length;
    if (boyut > MAX_BODY) { const e = new Error("Fotoğraf çok büyük"); e.kod = 413; throw e; }
    body += chunk;
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    const e = new Error("Geçersiz istek gövdesi"); e.kod = 400; throw e;
  }
}

createServer(async (req, res) => {
  corsUygula(req, res);
  if (req.method === "OPTIONS") return res.end();

  if (req.method === "GET" && req.url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, surum: 7,
      ses: Boolean(ELEVEN_KEY && VOICE_ID),
      defter: defterAcik(),                     // jeton bakiyesi sunucuda tutulabiliyor mu
      magaza: Boolean(RC_SECRET),               // satın alma doğrulaması açık mı
    }));
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
  const yol = Object.keys(LIMITS).find((u) => req.url.startsWith(u)) || "";
  if (limitAsildi(ip, yol)) {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Çok fazla istek, biraz sonra tekrar dene" }));
  }

  try {
    if (req.url.startsWith("/api/oturum")) {
      const sonuc = await oturumAc(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(sonuc));
    }

    if (req.url.startsWith("/api/satinalma")) {
      const sonuc = await satinAlmaSenkron(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(sonuc));
    }

    if (req.url.startsWith("/api/fal")) {
      const govde = await readBody(req);
      // ÖNCE hakkı düş (rezerve), sonra modele git: aynı jetonla iki fal bakılamasın
      const hak = await hakDus(govde, "fal");
      let fal;
      try { fal = await falBak(govde.image, govde.mimeType); }
      catch (e) { if (hak.uygulandi) await jetonIade(hak.kimlik, hak.alan); throw e; }
      // Fincan değilse ücret alma (istemci de almıyordu) — hakkı geri ver
      if (hak.uygulandi && fal && fal.fincan_mi === false) {
        await jetonIade(hak.kimlik, hak.alan);
        const h = await hesapKimlikten(hak.kimlik).catch(() => null);
        if (h) hak.bakiye = bakiyeOzet(h);
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(hak.uygulandi ? { ...fal, bakiye: hak.bakiye } : fal));
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

    if (req.url.startsWith("/api/hesap-sil")) {
      const govde = await readBody(req);
      await hesapSil(govde);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.url.startsWith("/api/ses")) {
      const govde = await readBody(req);
      const hak = await hakDus(govde, "ses");          // ses her zaman 1 jeton (bedava hak yok)
      let audio;
      try { audio = await seslendir(govde.text); }
      catch (e) { if (hak.uygulandi) await jetonIade(hak.kimlik, hak.alan); throw e; }
      const basliklar = { "content-type": "audio/mpeg", "content-length": audio.length };
      if (hak.uygulandi) basliklar["x-bakiye"] = JSON.stringify(hak.bakiye);   // gövde ses; bakiye başlıkta
      res.writeHead(200, basliklar);
      return res.end(audio);
    }

    res.writeHead(404).end();
  } catch (e) {
    // Ayrıntıyı yalnızca sunucu günlüğüne yaz: sağlayıcı hataları anahtar/istek kimliği sızdırabilir
    console.error("istek hatası", req.url, e && (e.stack || e.message || e));
    const kod = Number(e && e.kod) || 500;
    const mesaj = kod === 500 ? "Sunucu hatası" : String(e.message || "Geçersiz istek");
    res.writeHead(kod, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: mesaj }));
  }
}).listen(PORT, () => {
  console.log(`Fal API  → http://localhost:${PORT}/api/fal`);
  console.log(`Falcı sesi → ${ELEVEN_KEY && VOICE_ID ? "bağlı (" + TTS_MODEL + ")" : "KAPALI — anahtar yok, tarayıcı sesine düşecek"}`);
});
