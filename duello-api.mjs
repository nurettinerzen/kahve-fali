// Çiftler Düellosu — backend (oda eşleşmesi + AI sahte şık üretimi + AI hakem)
//
// Çalıştır:  ANTHROPIC_API_KEY=... node duello-api.mjs
// Aç:        http://localhost:8791/duello.html   (iki ayrı telefondan aynı adres)
//
// Oyun döngüsü (bölüm başına 5 soru):
//   1) "cevap"  — ikisi de kendi cevabını yazar (birbirini görmez)
//   2) "tahmin" — ikisi de eşinin cevabını tahmin eder
//                 Seviye 1-2: 4 şık (gerçek cevap + AI'ın ürettiği 3 sahte)
//                 Seviye 3-4: serbest metin, AI hakem tam/yakın/uzak der
//                 Seviye 5:   puan yok, sadece yüzleşme
//   3) "sonuc"  — cevaplar yan yana açılır, puan verilir, sonraki bölüm
//
// Oda durumu bellekte tutulur (prototip). Sunucu yeniden başlarsa odalar gider.

import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT || 8791;
const MODEL = "claude-haiku-4-5";
const ROOT = new URL(".", import.meta.url).pathname;
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

if (!client) console.warn("! ANTHROPIC_API_KEY yok — sahte şıklar havuzdan, hakem basit eşleşme yapacak.");

// ─────────────────────────────────────────────────────────── soru bankası
// tip: "sik" → tahmin 4 şıkla, "metin" → serbest metin + AI hakem, "acik" → puansız yüzleşme
const BANKA = {
  1: {
    ad: "Gerçekler",
    alt: "Isınma turu. Birbirinizi ne kadar iyi biliyorsunuz?",
    tip: "sik",
    sorular: [
      "En sevdiğin renk ne?",
      "Dışarıda yemek yesen ne söylersin?",
      "En sevdiğin içecek ne?",
      "Tatilde deniz mi, dağ mı, şehir mi?",
      "Canın tatlı çektiğinde ne yersin?",
      "En sevdiğin mevsim hangisi?",
      "Film gecesi olsa hangi türü seçersin?",
      "Kahveni nasıl içersin?",
    ],
  },
  2: {
    ad: "Alışkanlıklar",
    alt: "Gözünün önünde yaşadığın şeyler. Dikkat ettin mi?",
    tip: "sik",
    sorular: [
      "Sabah uyanınca ilk ne yaparsın?",
      "Telefonda en çok hangi uygulamada vakit geçirirsin?",
      "Evde en çok hangi köşede oturursun?",
      "Strese girince ne yaparsın?",
      "Yolda yürürken kulaklıkta ne çalar?",
      "Alışverişte en çok neye para harcarsın?",
      "Uyumadan önceki son işin ne?",
      "Hafta sonu boş kalsan ne yaparsın?",
    ],
  },
  3: {
    ad: "Varsayımlar",
    alt: "Artık şık yok. Tahminini kendin yazacaksın.",
    tip: "metin",
    sorular: [
      "Piyangodan büyük ikramiye çıksa ilk ne alırsın?",
      "Bir yıl çalışmadan yaşasan ne yapardın?",
      "Dünyanın herhangi bir yerinde yaşayabilsen neresi?",
      "Bir yeteneği anında kazanabilsen hangisi olurdu?",
      "Seni en iyi anlatan üç kelime ne?",
      "Bir günlüğüne başkası olabilsen kim olurdun?",
      "On yıl sonra kendini nerede görüyorsun?",
      "Hiç denemediğin ama çok istediğin şey ne?",
    ],
  },
  4: {
    ad: "Değerler",
    alt: "Burası zorlaşıyor. Yüzeyin altına iniyoruz.",
    tip: "metin",
    sorular: [
      "En çok neye kızarsın?",
      "Kendinle ilgili en çok neyle gurur duyuyorsun?",
      "Bir insanda affedemeyeceğin şey ne?",
      "Sana göre iyi bir gün nasıl geçer?",
      "Hayatında en çok neyi değiştirmek isterdin?",
      "Sence seni en iyi anlayan kişi kim?",
      "Kendine en çok hangi konuda haksızlık ediyorsun?",
      "Para olmasa hangi işi yapardın?",
    ],
  },
  5: {
    ad: "Kırılgan",
    alt: "Bu bölümde puan yok. Sadece söyleyin ve okuyun.",
    tip: "acik",
    sorular: [
      "En çok neyden korkuyorsun?",
      "Seni en son ne mutlu etti?",
      "Bana söylemediğin ama söylemek istediğin bir şey var mı?",
      "Beraberken kendini en çok ne zaman güvende hissediyorsun?",
      "Son zamanlarda en çok neyi kafana takıyorsun?",
      "Benim yaptığım hangi küçük şey sana iyi geliyor?",
      "Nasıl bir yaşlılık hayal ediyorsun?",
      "Bu ilişkide en çok neye ihtiyacın var?",
    ],
  },
};

// AI olmadığında kullanılacak yedek şık havuzu (kaba ama oyunu durdurmaz)
const YEDEK_SIKLAR = ["Bilmiyorum", "Fark etmez", "Hepsi olur", "Aklıma gelmiyor"];

const SORU_SAYISI = 5;
const PUAN = { tam: 10, yakin: 5, uzak: 0 };

// ─────────────────────────────────────────────────────────── oda yönetimi
const odalar = new Map();

const kodUret = () => {
  const harfler = "ABCDEFGHJKLMNPRSTUVYZ23456789"; // karışan karakterler yok
  let k;
  do {
    k = Array.from({ length: 4 }, () => harfler[Math.floor(Math.random() * harfler.length)]).join("");
  } while (odalar.has(k));
  return k;
};

const soruSec = (seviye) => {
  const havuz = [...BANKA[seviye].sorular];
  const secilen = [];
  while (secilen.length < SORU_SAYISI && havuz.length) {
    secilen.push(havuz.splice(Math.floor(Math.random() * havuz.length), 1)[0]);
  }
  return secilen;
};

const bolumKur = (oda, seviye) => {
  oda.seviye = seviye;
  oda.tip = BANKA[seviye].tip;
  oda.sorular = soruSec(seviye);
  oda.faz = "cevap";
  oda.cevaplar = [[], []];
  oda.secenekler = [null, null]; // secenekler[hedef][i] = hedefin cevabı için 4 şık
  oda.tahminler = [[], []];
  oda.puanlar = [[], []];
  oda.hazir = [false, false];
  oda.v++;
};

const tamamMi = (dizi) => dizi.filter((x) => typeof x === "string" && x.trim()).length >= SORU_SAYISI;

// ─────────────────────────────────────────────────────────── AI: sahte şık üretimi
// Kritik detay: sahte şıklar gerçek cevapla aynı uzunlukta, aynı kişisellikte olmalı.
// "annemin yaptığı mantı" yanına "pizza" koyarsan oyun ölür.
async function sahteSiklarUret(sorular, cevaplar) {
  if (!client) {
    return cevaplar.map((c) => karistir([c, ...YEDEK_SIKLAR.slice(0, 3)]));
  }
  const liste = sorular.map((s, i) => `${i + 1}. Soru: ${s}\n   Gerçek cevap: ${cevaplar[i]}`).join("\n");
  const istek = `Bir çift oyunu için çeldirici cevaplar üreteceksin.

Aşağıda sorular ve bir kişinin GERÇEK cevapları var. Her soru için, gerçek cevabın yanına konulacak
3 SAHTE cevap üret.

Kurallar — hepsi zorunlu:
- Sahte cevaplar gerçek cevapla AYNI uzunlukta olsun (gerçek "mantı" ise sahteler tek kelime;
  gerçek "annemin yaptığı mantı" ise sahteler de o kadar detaylı ve kişisel olsun).
- Aynı üslupta, aynı samimiyette yaz. Gerçek cevap hemen sırıtmasın — oyunun tüm zorluğu bu.
- Sahteler makul olsun: o kişinin gerçekten diyebileceği, ama demediği şeyler.
- Gerçek cevapla anlamca çakışmasın (gerçek "mavi" ise "lacivert" yazma, ayırt edilemez olur).
- Türkçe yaz. Baş harf kullanımını gerçek cevaba benzet.

${liste}

Sadece JSON dön, başka hiçbir şey yazma:
{"sikla": [["sahte1","sahte2","sahte3"], ...]}  // ${sorular.length} adet, soru sırasına göre`;

  try {
    const yanit = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: istek }],
    });
    const ham = yanit.content.find((p) => p.type === "text")?.text ?? "";
    const veri = JSON.parse(ham.slice(ham.indexOf("{"), ham.lastIndexOf("}") + 1));
    return cevaplar.map((c, i) => {
      const sahte = (veri.sikla?.[i] ?? []).filter((s) => typeof s === "string" && s.trim()).slice(0, 3);
      while (sahte.length < 3) sahte.push(YEDEK_SIKLAR[sahte.length]);
      return karistir([c, ...sahte]);
    });
  } catch (e) {
    console.error("şık üretimi başarısız:", e.message);
    return cevaplar.map((c) => karistir([c, ...YEDEK_SIKLAR.slice(0, 3)]));
  }
}

const karistir = (dizi) => {
  const d = [...dizi];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
};

// ─────────────────────────────────────────────────────────── AI: hakem
const sadelestir = (s) =>
  (s || "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function basitHakem(gercek, tahmin) {
  const g = sadelestir(gercek);
  const t = sadelestir(tahmin);
  if (!t) return "uzak";
  if (g === t) return "tam";
  if (g.includes(t) || t.includes(g)) return "yakin";
  const gk = new Set(g.split(" ").filter((w) => w.length > 3));
  const ortak = t.split(" ").filter((w) => w.length > 3 && gk.has(w));
  return ortak.length ? "yakin" : "uzak";
}

// Serbest metin tahminlerini değerlendirir. "yakın" kademesi kritik:
// kullanıcı haksızlığa uğradığını hissederse oyunu bırakır.
async function hakemlik(sorular, gercekler, tahminler) {
  const yedek = () => sorular.map((_, i) => basitHakem(gercekler[i], tahminler[i]));
  if (!client) return yedek();

  const liste = sorular
    .map((s, i) => `${i + 1}. Soru: ${s}\n   Gerçek: ${gercekler[i]}\n   Tahmin: ${tahminler[i]}`)
    .join("\n");
  const istek = `Bir çift oyununda tahminleri değerlendiriyorsun.

Her satırda bir sorunun gerçek cevabı ve eşinin tahmini var. Her tahmin için karar ver:
- "tam"   → aynı şeyi söylüyorlar (kelimeler farklı olabilir: "mantı" ve "annemin mantısı" = tam)
- "yakin" → aynı yöne gidiyor ama tam tutturamamış ("mavi" vs "lacivert", "yürüyüş" vs "spor")
- "uzak"  → alakasız

Cömert ol ama sulandırma. Şüphedeysen "yakin" ver — kullanıcı haksızlığa uğradığını hissetmesin.

${liste}

Sadece JSON dön: {"kademeler": ["tam"|"yakin"|"uzak", ...]}  // ${sorular.length} adet`;

  try {
    const yanit = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: istek }],
    });
    const ham = yanit.content.find((p) => p.type === "text")?.text ?? "";
    const veri = JSON.parse(ham.slice(ham.indexOf("{"), ham.lastIndexOf("}") + 1));
    return sorular.map((_, i) =>
      ["tam", "yakin", "uzak"].includes(veri.kademeler?.[i]) ? veri.kademeler[i] : basitHakem(gercekler[i], tahminler[i])
    );
  } catch (e) {
    console.error("hakemlik başarısız:", e.message);
    return yedek();
  }
}

// ─────────────────────────────────────────────────────────── faz geçişleri
async function fazIlerlet(oda) {
  if (oda.faz === "cevap" && tamamMi(oda.cevaplar[0]) && tamamMi(oda.cevaplar[1])) {
    oda.faz = "hazirlaniyor";
    oda.v++;
    if (oda.tip === "sik") {
      const [s0, s1] = await Promise.all([
        sahteSiklarUret(oda.sorular, oda.cevaplar[0]),
        sahteSiklarUret(oda.sorular, oda.cevaplar[1]),
      ]);
      oda.secenekler = [s0, s1];
    }
    // Seviye 5'te tahmin yok, doğrudan yüzleşme
    oda.faz = oda.tip === "acik" ? "sonuc" : "tahmin";
    oda.v++;
    return;
  }

  if (oda.faz === "tahmin" && tamamMi(oda.tahminler[0]) && tamamMi(oda.tahminler[1])) {
    oda.faz = "hazirlaniyor";
    oda.v++;
    for (const ben of [0, 1]) {
      const es = 1 - ben;
      if (oda.tip === "sik") {
        oda.puanlar[ben] = oda.tahminler[ben].map((t, i) =>
          sadelestir(t) === sadelestir(oda.cevaplar[es][i]) ? "tam" : "uzak"
        );
      } else {
        oda.puanlar[ben] = await hakemlik(oda.sorular, oda.cevaplar[es], oda.tahminler[ben]);
      }
    }
    oda.faz = "sonuc";
    oda.v++;
  }
}

// ─────────────────────────────────────────────────────────── durum (sızdırmadan)
function durum(oda, ben) {
  const es = 1 - ben;
  const g = {
    kod: oda.kod,
    v: oda.v,
    faz: oda.faz,
    seviye: oda.seviye,
    seviyeAd: BANKA[oda.seviye].ad,
    seviyeAlt: BANKA[oda.seviye].alt,
    tip: oda.tip,
    sonSeviye: !BANKA[oda.seviye + 1],
    soruSayisi: SORU_SAYISI,
    sorular: oda.sorular,
    ben: { ad: oda.oyuncular[ben].ad, no: ben },
    es: oda.oyuncular[es] ? { ad: oda.oyuncular[es].ad } : null,
    benimCevaplarim: oda.cevaplar[ben],
    benimTahminlerim: oda.tahminler[ben],
    esBitirdi: {
      cevap: tamamMi(oda.cevaplar[es]),
      tahmin: tamamMi(oda.tahminler[es]),
    },
    toplam: oda.toplam,
    hazir: oda.hazir,
  };

  // Şıklar: eşimin cevabını tahmin edeceğim için EŞİMİN şıkları bana gösterilir
  if (oda.faz === "tahmin" && oda.tip === "sik") g.secenekler = oda.secenekler[es];

  // Cevaplar sadece yüzleşmede açılır
  if (oda.faz === "sonuc") {
    g.sonuc = {
      benimCevaplarim: oda.cevaplar[ben],
      esinCevaplari: oda.cevaplar[es],
      benimTahminlerim: oda.tahminler[ben],
      esinTahminleri: oda.tahminler[es],
      benimKademelerim: oda.puanlar[ben],
      esinKademeleri: oda.puanlar[es],
    };
  }
  return g;
}

const puanTopla = (kademeler) => (kademeler ?? []).reduce((t, k) => t + (PUAN[k] ?? 0), 0);

// ─────────────────────────────────────────────────────────── HTTP
const govde = (req) =>
  new Promise((coz, hata) => {
    let d = "";
    req.on("data", (p) => {
      d += p;
      if (d.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        coz(d ? JSON.parse(d) : {});
      } catch {
        hata(new Error("bozuk istek"));
      }
    });
  });

const json = (res, kod, veri) => {
  res.writeHead(kod, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(veri));
};

// İsteği yapan oyuncuyu doğrular (eşinin ekranını kimse çekemesin diye)
function kimlik(oda, s) {
  const no = Number(s.get("oyuncu"));
  const tok = s.get("token");
  if (!oda || !oda.oyuncular[no] || oda.oyuncular[no].token !== tok) return null;
  return no;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const yol = decodeURIComponent(url.pathname);
  const s = url.searchParams;

  try {
    // ── oda kur
    if (yol === "/api/kur" && req.method === "POST") {
      const { ad } = await govde(req);
      if (!ad?.trim()) return json(res, 400, { hata: "Adını yaz." });
      const kod = kodUret();
      const oda = {
        kod,
        v: 0,
        toplam: [0, 0],
        oyuncular: [{ ad: ad.trim().slice(0, 20), token: randomUUID() }],
        olusma: Date.now(),
      };
      bolumKur(oda, 1);
      oda.faz = "lobi";
      odalar.set(kod, oda);
      return json(res, 200, { kod, oyuncu: 0, token: oda.oyuncular[0].token });
    }

    // ── odaya katıl
    if (yol === "/api/katil" && req.method === "POST") {
      const { kod, ad } = await govde(req);
      const oda = odalar.get((kod || "").toUpperCase().trim());
      if (!oda) return json(res, 404, { hata: "Böyle bir oda yok." });
      if (oda.oyuncular[1]) return json(res, 409, { hata: "Bu oda dolu." });
      if (!ad?.trim()) return json(res, 400, { hata: "Adını yaz." });
      oda.oyuncular[1] = { ad: ad.trim().slice(0, 20), token: randomUUID() };
      oda.faz = "cevap";
      oda.v++;
      return json(res, 200, { kod: oda.kod, oyuncu: 1, token: oda.oyuncular[1].token });
    }

    // ── durum (istemci 2 sn'de bir sorar)
    if (yol === "/api/durum") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oda bulunamadı ya da oturum düştü." });
      return json(res, 200, durum(oda, ben));
    }

    // ── kendi cevabını gönder
    if (yol === "/api/cevap" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      const { indeks, metin } = await govde(req);
      if (oda.faz !== "cevap") return json(res, 409, { hata: "Bu aşama geçti." });
      if (!(indeks >= 0 && indeks < SORU_SAYISI)) return json(res, 400, { hata: "Geçersiz soru." });
      oda.cevaplar[ben][indeks] = String(metin || "").trim().slice(0, 120);
      oda.v++;
      await fazIlerlet(oda);
      return json(res, 200, durum(oda, ben));
    }

    // ── eşinin cevabını tahmin et
    if (yol === "/api/tahmin" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      const { indeks, metin } = await govde(req);
      if (oda.faz !== "tahmin") return json(res, 409, { hata: "Bu aşama geçti." });
      if (!(indeks >= 0 && indeks < SORU_SAYISI)) return json(res, 400, { hata: "Geçersiz soru." });
      oda.tahminler[ben][indeks] = String(metin || "").trim().slice(0, 120);
      oda.v++;
      await fazIlerlet(oda);
      return json(res, 200, durum(oda, ben));
    }

    // ── sonraki bölüme hazırım
    if (yol === "/api/hazir" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      if (oda.faz !== "sonuc") return json(res, 409, { hata: "Henüz bölüm bitmedi." });
      oda.hazir[ben] = true;
      oda.v++;
      if (oda.hazir[0] && oda.hazir[1]) {
        oda.toplam = [oda.toplam[0] + puanTopla(oda.puanlar[0]), oda.toplam[1] + puanTopla(oda.puanlar[1])];
        const sonraki = BANKA[oda.seviye + 1] ? oda.seviye + 1 : oda.seviye;
        bolumKur(oda, sonraki);
      }
      return json(res, 200, durum(oda, ben));
    }

    // ── statik dosyalar
    let dosyaYolu = yol === "/" ? "/duello.html" : yol;
    const guvenli = normalize(dosyaYolu).replace(/^(\.\.[/\\])+/, "");
    const dosya = join(ROOT, guvenli);
    if (!dosya.startsWith(ROOT) || guvenli.startsWith("/.env") || guvenli.includes("node_modules")) {
      return res.writeHead(403).end("yasak");
    }
    const veri = await readFile(dosya);
    res.writeHead(200, { "content-type": TYPES[extname(dosya)] || "application/octet-stream" });
    res.end(veri);
  } catch (e) {
    if (e.code === "ENOENT") return res.writeHead(404).end("bulunamadı");
    console.error(e);
    json(res, 500, { hata: "Sunucu hatası." });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Çiftler Düellosu → http://localhost:${PORT}/duello.html`);
  console.log(`İkinci telefon için: http://<mac-ip-adresin>:${PORT}/duello.html`);
});
