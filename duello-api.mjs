// Çiftler Düellosu — backend (oda eşleşmesi + AI sahte şık üretimi + AI hakem)
//
// Çalıştır:  ANTHROPIC_API_KEY=... node duello-api.mjs
// Aç:        http://localhost:8791/duello.html   (iki ayrı telefondan aynı adres)
//
// Yapı: ana menü = merkez. Oradan üç şey başlar:
//   - Günlük Soru: günde 1 soru, ikisi cevaplar + tahmin eder, seri (streak) tutulur
//   - Düello: 5 bölüm, derinleşerek (Bölüm 3'ten itibaren PREMIUM)
//   - Paketler: temalı soru setleri (çoğu premium)
//
// Her etkinlik aynı motoru kullanır:
//   1) "cevap"  — ikisi de kendi cevabını yazar (birbirini görmez)
//   2) "tahmin" — ikisi de eşinin cevabını tahmin eder
//               tip "sik":   4 şık (gerçek + AI'ın ürettiği 3 sahte)
//               tip "metin": serbest metin, AI hakem tam/yakın/uzak der
//               tip "acik":  tahmin yok, puan yok, sadece yüzleşme
//   3) "sonuc"  — cevaplar yan yana, puan, menüye dönüş
//
// Odalar duello-odalar.json'a kaydedilir — sunucu yeniden başlasa da oyun kaybolmaz.

import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
      "Dışarıda yemek yesen ne sipariş edersin?",
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

// Temalı paketler — ilk-gunler ücretsiz (tat versin), gerisi premium
const PAKETLER = [
  {
    id: "ilk-gunler",
    ad: "İlk Günler",
    alt: "Her şeyin başladığı zamana dönüyoruz.",
    tip: "metin",
    premium: false,
    sorular: [
      "Beni ilk gördüğünde aklından ne geçti?",
      "Bana aşık olduğunu ilk ne zaman anladın?",
      "İlk buluşmamızda en çok neye heyecanlandın?",
      "İlk günlerde benimle ilgili seni en çok şaşırtan şey neydi?",
      "Arkadaşlarına benden ilk nasıl bahsettin?",
      "İlk mesajlaşmalarımızdan aklında kalan bir detay var mı?",
      "O günlere dönsen kendine ne tavsiye ederdin?",
      "İlk tartışmamız neydi, hatırlıyor musun?",
    ],
  },
  {
    id: "evlilik",
    ad: "Evlilik",
    alt: "Aynı evi paylaşanların oyunu.",
    tip: "metin",
    premium: true,
    sorular: [
      "Evliliğimizde seni en çok güldüren rutinimiz ne?",
      "Sence hangi konuda harika bir takımız?",
      "Evde benim en gereksiz alışkanlığım sence hangisi?",
      "Evliliğin sana öğrettiği en büyük şey ne?",
      "Yıllar sonra torunlara anlatacağın ilk hikayemiz hangisi olur?",
      "Benim aileme dair en sevdiğin şey ne?",
      "Ev işlerinde bende en çok neye şaşırıyorsun?",
      "Sence 10 yıl sonra pazar sabahlarımız nasıl geçecek?",
    ],
  },
  {
    id: "tatil",
    ad: "Tatil Hayalleri",
    alt: "Valizleri hayalen toplayın.",
    tip: "sik",
    premium: true,
    sorular: [
      "Sınırsız bütçeyle ilk nereye giderdik?",
      "Tatilin ilk günü ne yaparsın?",
      "Deniz kenarında bungalov mu, ormanda kütük ev mi?",
      "Tatilde en çok neye para harcarsın?",
      "Yol müziği olarak ne açarsın?",
      "Tatilde sabahçı mısın, gececi mi?",
      "Bir tatili mahveden şey sence ne?",
      "Valizini kaç günde toplarsın?",
    ],
  },
  {
    id: "uzun-yol",
    ad: "Uzun Yol",
    alt: "Arabada, kuyrukta, beklerken. Saçma ama tatlı.",
    tip: "sik",
    premium: true,
    sorular: [
      "Bir süper gücün olsa hangisini seçerdin?",
      "Zamanda tek yön bilet: geçmiş mi, gelecek mi?",
      "Bir film karakteriyle bir gün geçirsen kim olurdu?",
      "Ünlü olsan hangi alanda ünlü olurdun?",
      "Bir yıl boyunca tek yemek yiyeceksin: ne seçersin?",
      "Görünmezlik mi, uçmak mı?",
      "Hangi çizgi film evreninde yaşardın?",
      "Issız adaya tek eşya: ne alırsın?",
    ],
  },
  {
    id: "barisma",
    ad: "Barışma",
    alt: "Tartışma sonrası. Puan yok, kazanan yok — sadece konuşun.",
    tip: "acik",
    premium: true,
    sorular: [
      "Az önce seni asıl üzen neydi?",
      "Şu an benden duymaya ihtiyacın olan cümle ne?",
      "Bu tartışmada kendi payım neydi — dürüstçe söylesem dinler misin?",
      "Sarılsak şu an iyi gelir mi, yoksa biraz zaman mı lazım?",
      "Bir dahaki sefere bunu nasıl daha iyi konuşabiliriz?",
      "Bu konu dışında, şu an aramız nasıl?",
    ],
  },
];

// Günlük soru havuzu — karışık derinlik, kuru değil
const GUNLUK = {
  ad: "Günün Sorusu",
  alt: "Günde bir soru. Seriyi bozmayın.",
  tip: "metin",
  sorular: [
    "Bugün seni gülümseten ilk şey neydi?",
    "Şu an beraber nereye ışınlanmak isterdin?",
    "Bu hafta seni en çok yoran şey ne oldu?",
    "Çocukluğundan bana hiç anlatmadığın bir anı var mı?",
    "Şu aralar kafanda dönüp duran şarkı hangisi?",
    "Yarın hiçbir sorumluluğun olmasa sabah ilk ne yapardın?",
    "Beni bir hayvana benzetsen hangisi olurdum?",
    "Son zamanlarda vazgeçemediğin küçük bir keyif ne?",
    "Beraber izlediğimiz en iyi şey neydi sence?",
    "Şu an hayatında daha fazla olmasını istediğin şey ne?",
    "En son ne zaman kendinle gurur duydun?",
    "Bana ilk mesajını atmadan önce ne düşünüyordun?",
    "Şu aralar en çok neyin hayalini kuruyorsun?",
    "Beni üç emojiyle anlatsan hangilerini seçerdin?",
    "İlişkimizde en sevdiğin küçük ritüelimiz hangisi?",
    "Son rüyandan hatırladığın bir şey var mı?",
    "Küçükken büyüyünce ne olmak istiyordun?",
    "Şu an masada ne olsa şahane olurdu?",
    "En son beni düşünüp güldüğün an neydi?",
    "Yeniden 18'inde olsan neyi farklı yapardın?",
    "Bugün kendine koyduğun küçük bir hedef var mı?",
    "Bugün dünyadan bir şeyi silebilsen ne olurdu?",
    "Sence ikimizin en komik ortak huyu ne?",
    "Bana sormak isteyip hiç sormadığın şey ne?",
  ],
};

// AI olmadığında kullanılacak yedek şık havuzu (kaba ama oyunu durdurmaz)
const YEDEK_SIKLAR = ["Bilmiyorum", "Fark etmez", "Hepsi olur", "Aklıma gelmiyor"];

const SORU_SAYISI = 5; // düello + paket bölümleri; günlük tek soru
const PUAN = { tam: 10, yakin: 5, uzak: 0 };

// ─────────────────────────────────────────────────────────── kalıcılık
const ODA_DOSYASI = join(ROOT, "duello-odalar.json");
const odalar = new Map();
try {
  for (const [k, o] of JSON.parse(readFileSync(ODA_DOSYASI, "utf8"))) odalar.set(k, o);
  console.log(`${odalar.size} oda diskten yüklendi.`);
} catch {}

let kayitSayaci = null;
function kaydet() {
  clearTimeout(kayitSayaci);
  kayitSayaci = setTimeout(async () => {
    try {
      await writeFile(ODA_DOSYASI, JSON.stringify([...odalar.entries()]));
    } catch (e) {
      console.error("oda kaydı başarısız:", e.message);
    }
  }, 500);
}

// ─────────────────────────────────────────────────────────── yardımcılar
const kodUret = () => {
  const harfler = "ABCDEFGHJKLMNPRSTUVYZ23456789"; // karışan karakterler yok
  let k;
  do {
    k = Array.from({ length: 6 }, () => harfler[Math.floor(Math.random() * harfler.length)]).join("");
  } while (odalar.has(k));
  return k;
};

const bugun = () => new Date().toLocaleDateString("sv"); // YYYY-MM-DD
const dun = () => new Date(Date.now() - 864e5).toLocaleDateString("sv");

const soruSec = (havuz, adet) => {
  const kopya = [...havuz];
  const secilen = [];
  while (secilen.length < adet && kopya.length) {
    secilen.push(kopya.splice(Math.floor(Math.random() * kopya.length), 1)[0]);
  }
  return secilen;
};

const karistir = (dizi) => {
  const d = [...dizi];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
};

const tamamMi = (dizi, adet) => dizi.filter((x) => typeof x === "string" && x.trim()).length >= adet;

// ─────────────────────────────────────────────────────────── etkinlik motoru
// aktif = { tur: "duello"|"paket"|"gunluk", seviye?, paketId?, ad, alt, tip }
function etkinlikKur(oda, aktif, sorular) {
  oda.aktif = aktif;
  oda.sorular = sorular;
  oda.soruSayisi = sorular.length;
  oda.faz = "cevap";
  oda.cevaplar = [[], []];
  oda.secenekler = [null, null];
  oda.tahminler = [[], []];
  oda.puanlar = [[], []];
  oda.hazir = [false, false];
  oda.v++;
}

function menuyeDon(oda) {
  oda.faz = "menu";
  oda.aktif = null;
  oda.duvarSonrasi = null;
  oda.hazir = [false, false];
  oda.v++;
}

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
- ÖNCE gerçek cevabın soruyu NASIL yorumladığına bak, sahteleri aynı kategoride üret.
  ("Dışarıda ne söylersin?" sorusuna gerçek cevap bir yemek adıysa sahteler de yemek adı olsun;
  gerçek cevap bir yorum cümlesiyse sahteler de yorum cümlesi olsun. Kategori karışırsa gerçek
  cevap anında sırıtır, oyun ölür.)
- Sahte cevaplar gerçek cevapla AYNI uzunlukta olsun (gerçek "mantı" ise sahteler tek kelime;
  gerçek "annemin yaptığı mantı" ise sahteler de o kadar detaylı ve kişisel olsun).
- Aynı üslupta, aynı samimiyette, aynı özenle yaz. Gerçek cevap kısa ve özensizse (küçük harf,
  yarım kelime, argo) sahteler de öyle olsun. Gerçek cevap rastgele/saçma bir şeyse ("asd" gibi)
  sahteler de aynı tarz kısa saçma şeyler olsun ("qwe", "jj", "xx" gibi) — ciddi cevap üretme.
- Sahteler makul olsun: o kişinin gerçekten diyebileceği, ama demediği şeyler.
- Gerçek cevapla anlamca çakışmasın (gerçek "mavi" ise "lacivert" yazma, ayırt edilemez olur).
- Türkçe yaz. Baş harf kullanımını gerçek cevaba benzet.

${liste}

Sadece JSON dön, başka hiçbir şey yazma:
{"sikla": [["sahte1","sahte2","sahte3"], ...]}  // ${sorular.length} adet, soru sırasına göre`;

  try {
    const yanit = await client.messages.create(
      { model: MODEL, max_tokens: 1200, messages: [{ role: "user", content: istek }] },
      { timeout: 15000, maxRetries: 1 } // takılırsa oyunu bekletme, yedeğe düş
    );
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
    const yanit = await client.messages.create(
      { model: MODEL, max_tokens: 400, messages: [{ role: "user", content: istek }] },
      { timeout: 15000, maxRetries: 1 } // hakem takılırsa basit eşleşmeye düş
    );
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
  const n = oda.soruSayisi;

  if (oda.faz === "cevap" && tamamMi(oda.cevaplar[0], n) && tamamMi(oda.cevaplar[1], n)) {
    oda.faz = "hazirlaniyor";
    oda.v++;
    if (oda.aktif.tip === "sik") {
      const [s0, s1] = await Promise.all([
        sahteSiklarUret(oda.sorular, oda.cevaplar[0]),
        sahteSiklarUret(oda.sorular, oda.cevaplar[1]),
      ]);
      oda.secenekler = [s0, s1];
    }
    // "acik" tipte tahmin yok, doğrudan yüzleşme
    oda.faz = oda.aktif.tip === "acik" ? "sonuc" : "tahmin";
    oda.v++;
    kaydet();
    return;
  }

  if (oda.faz === "tahmin" && tamamMi(oda.tahminler[0], n) && tamamMi(oda.tahminler[1], n)) {
    oda.faz = "hazirlaniyor";
    oda.v++;
    for (const ben of [0, 1]) {
      const es = 1 - ben;
      if (oda.aktif.tip === "sik") {
        oda.puanlar[ben] = oda.tahminler[ben].map((t, i) =>
          sadelestir(t) === sadelestir(oda.cevaplar[es][i]) ? "tam" : "uzak"
        );
      } else {
        oda.puanlar[ben] = await hakemlik(oda.sorular, oda.cevaplar[es], oda.tahminler[ben]);
      }
    }
    oda.faz = "sonuc";
    oda.v++;
    kaydet();
  }
}

const puanTopla = (kademeler) => (kademeler ?? []).reduce((t, k) => t + (PUAN[k] ?? 0), 0);

// Bölüm bitti, ikisi de "devam" dedi: puanları işle, ilerlemeyi kaydet, menüye dön
function etkinligiBitir(oda) {
  const a = oda.aktif;
  if (a.tip !== "acik") {
    oda.toplam = [oda.toplam[0] + puanTopla(oda.puanlar[0]), oda.toplam[1] + puanTopla(oda.puanlar[1])];
  }
  if (a.tur === "duello") {
    oda.duelloSeviye = a.seviye + 1; // 6 = düello tamamlandı
  } else if (a.tur === "paket") {
    if (!oda.paketBitti.includes(a.paketId)) oda.paketBitti.push(a.paketId);
  } else if (a.tur === "gunluk") {
    oda.gunluk.seri = oda.gunluk.sonTarih === dun() ? oda.gunluk.seri + 1 : 1;
    oda.gunluk.sonTarih = bugun();
    oda.gunluk.kullanilan.push(oda.gunlukSoru);
    if (oda.gunluk.kullanilan.length >= GUNLUK.sorular.length) oda.gunluk.kullanilan = [];
  }
  menuyeDon(oda);
}

// ─────────────────────────────────────────────────────────── etkinlik başlatma
function etkinlikBaslat(oda, tur, paketId) {
  if (tur === "gunluk") {
    if (oda.gunluk.sonTarih === bugun()) {
      return { hata: "Bugünün sorusunu cevapladınız. Yarın yeni soru gelecek.", kod: 409 };
    }
    const acik = GUNLUK.sorular.map((_, i) => i).filter((i) => !oda.gunluk.kullanilan.includes(i));
    const idx = acik[Math.floor(Math.random() * acik.length)];
    oda.gunlukSoru = idx;
    etkinlikKur(oda, { tur, ad: GUNLUK.ad, alt: GUNLUK.alt, tip: GUNLUK.tip }, [GUNLUK.sorular[idx]]);
    return {};
  }

  if (tur === "duello") {
    const seviye = oda.duelloSeviye > 5 ? 1 : oda.duelloSeviye; // bitirince baştan
    if (seviye >= 3 && !oda.premium) {
      oda.faz = "duvar";
      oda.duvarSonrasi = { tur };
      oda.v++;
      return {};
    }
    if (oda.duelloSeviye > 5) oda.duelloSeviye = 1;
    const b = BANKA[seviye];
    etkinlikKur(oda, { tur, seviye, ad: b.ad, alt: b.alt, tip: b.tip }, soruSec(b.sorular, SORU_SAYISI));
    return {};
  }

  if (tur === "paket") {
    const p = PAKETLER.find((x) => x.id === paketId);
    if (!p) return { hata: "Böyle bir paket yok.", kod: 404 };
    if (p.premium && !oda.premium) {
      oda.faz = "duvar";
      oda.duvarSonrasi = { tur, paketId };
      oda.v++;
      return {};
    }
    etkinlikKur(oda, { tur, paketId, ad: p.ad, alt: p.alt, tip: p.tip }, soruSec(p.sorular, SORU_SAYISI));
    return {};
  }

  return { hata: "Bilinmeyen etkinlik.", kod: 400 };
}

// ─────────────────────────────────────────────────────────── durum (sızdırmadan)
function durum(oda, ben) {
  const es = 1 - ben;
  const g = {
    kod: oda.kod,
    v: oda.v,
    faz: oda.faz,
    ben: { ad: oda.oyuncular[ben].ad, no: ben },
    es: oda.oyuncular[es] ? { ad: oda.oyuncular[es].ad } : null,
    toplam: oda.toplam,
    premium: oda.premium,
    menu: {
      duelloSeviye: Math.min(oda.duelloSeviye, 6),
      duelloAd: BANKA[Math.min(oda.duelloSeviye, 5)].ad,
      duelloBitti: oda.duelloSeviye > 5,
      gunluk: { seri: oda.gunluk.seri, bugunYapildi: oda.gunluk.sonTarih === bugun() },
      paketler: PAKETLER.map((p) => ({
        id: p.id,
        ad: p.ad,
        alt: p.alt,
        premium: p.premium,
        bitti: oda.paketBitti.includes(p.id),
      })),
    },
  };

  if (oda.aktif) {
    g.aktif = oda.aktif;
    g.soruSayisi = oda.soruSayisi;
    g.sorular = oda.sorular;
    g.benimCevaplarim = oda.cevaplar[ben];
    g.benimTahminlerim = oda.tahminler[ben];
    g.esBitirdi = {
      cevap: tamamMi(oda.cevaplar[es], oda.soruSayisi),
      tahmin: tamamMi(oda.tahminler[es], oda.soruSayisi),
    };
    g.hazir = oda.hazir;

    // Şıklar: eşimin cevabını tahmin edeceğim için EŞİMİN şıkları bana gösterilir
    if (oda.faz === "tahmin" && oda.aktif.tip === "sik") g.secenekler = oda.secenekler[es];

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
  }
  return g;
}

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
        faz: "lobi",
        aktif: null,
        duvarSonrasi: null,
        premium: false,
        toplam: [0, 0],
        duelloSeviye: 1,
        paketBitti: [],
        gunluk: { seri: 0, sonTarih: null, kullanilan: [] },
        gunlukSoru: null,
        sorular: [],
        soruSayisi: SORU_SAYISI,
        cevaplar: [[], []],
        secenekler: [null, null],
        tahminler: [[], []],
        puanlar: [[], []],
        hazir: [false, false],
        oyuncular: [{ ad: ad.trim().slice(0, 20), token: randomUUID() }],
        davetToken: randomUUID(), // tek kullanımlık davet linki
        olusma: Date.now(),
      };
      odalar.set(kod, oda);
      kaydet();
      return json(res, 200, { kod, oyuncu: 0, token: oda.oyuncular[0].token });
    }

    // ── davet linki bilgisi (link tıklanınca "X seni davet etti" göstermek için)
    if (yol === "/api/davet") {
      const t = s.get("token");
      for (const o of odalar.values()) {
        if (t && o.davetToken === t && !o.oyuncular[1]) {
          return json(res, 200, { davetEden: o.oyuncular[0].ad });
        }
      }
      return json(res, 404, { hata: "Bu davet linki geçersiz ya da daha önce kullanılmış." });
    }

    // ── odaya katıl
    if (yol === "/api/katil" && req.method === "POST") {
      const { kod, ad } = await govde(req);
      const oda = odalar.get((kod || "").toUpperCase().trim());
      if (!oda) return json(res, 404, { hata: "Böyle bir oda yok." });
      if (oda.oyuncular[1]) return json(res, 409, { hata: "Bu oda dolu." });
      if (!ad?.trim()) return json(res, 400, { hata: "Adını yaz." });
      oda.oyuncular[1] = { ad: ad.trim().slice(0, 20), token: randomUUID() };
      oda.faz = "menu";
      oda.v++;
      kaydet();
      return json(res, 200, { kod: oda.kod, oyuncu: 1, token: oda.oyuncular[1].token });
    }

    // ── durum (istemci 2 sn'de bir sorar)
    if (yol === "/api/durum") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oda bulunamadı ya da oturum düştü." });
      return json(res, 200, durum(oda, ben));
    }

    // ── etkinlik başlat (menüden)
    if (yol === "/api/baslat" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      if (oda.faz !== "menu") return json(res, 409, { hata: "Zaten bir etkinlik sürüyor." });
      const { tur, paketId } = await govde(req);
      const sonuc = etkinlikBaslat(oda, tur, paketId);
      if (sonuc.hata) return json(res, sonuc.kod, { hata: sonuc.hata });
      kaydet();
      return json(res, 200, durum(oda, ben));
    }

    // ── kendi cevabını gönder
    if (yol === "/api/cevap" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      const { indeks, metin } = await govde(req);
      if (oda.faz !== "cevap") return json(res, 409, { hata: "Bu aşama geçti." });
      if (!(indeks >= 0 && indeks < oda.soruSayisi)) return json(res, 400, { hata: "Geçersiz soru." });
      oda.cevaplar[ben][indeks] = String(metin || "").trim().slice(0, 120);
      oda.v++;
      await fazIlerlet(oda);
      kaydet();
      return json(res, 200, durum(oda, ben));
    }

    // ── eşinin cevabını tahmin et
    if (yol === "/api/tahmin" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      const { indeks, metin } = await govde(req);
      if (oda.faz !== "tahmin") return json(res, 409, { hata: "Bu aşama geçti." });
      if (!(indeks >= 0 && indeks < oda.soruSayisi)) return json(res, 400, { hata: "Geçersiz soru." });
      oda.tahminler[ben][indeks] = String(metin || "").trim().slice(0, 120);
      oda.v++;
      await fazIlerlet(oda);
      kaydet();
      return json(res, 200, durum(oda, ben));
    }

    // ── sonuç ekranından devam
    if (yol === "/api/hazir" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      if (oda.faz !== "sonuc") return json(res, 409, { hata: "Henüz bölüm bitmedi." });
      oda.hazir[ben] = true;
      oda.v++;
      if (oda.hazir[0] && oda.hazir[1]) etkinligiBitir(oda);
      kaydet();
      return json(res, 200, durum(oda, ben));
    }

    // ── premium aç (PROTOTİP: gerçek ödeme yok, tek dokunuş)
    if (yol === "/api/premium" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      oda.premium = true; // tek abonelik iki hesabı da açar
      if (oda.faz === "duvar" && oda.duvarSonrasi) {
        const { tur, paketId } = oda.duvarSonrasi;
        oda.faz = "menu";
        etkinlikBaslat(oda, tur, paketId);
      }
      oda.v++;
      kaydet();
      return json(res, 200, durum(oda, ben));
    }

    // ── duvardan vazgeç
    if (yol === "/api/duvar-kapat" && req.method === "POST") {
      const oda = odalar.get((s.get("kod") || "").toUpperCase());
      const ben = kimlik(oda, s);
      if (ben === null) return json(res, 403, { hata: "Oturum düştü." });
      if (oda.faz === "duvar") menuyeDon(oda);
      kaydet();
      return json(res, 200, durum(oda, ben));
    }

    // ── statik dosyalar
    let dosyaYolu = yol === "/" ? "/duello.html" : yol;
    const guvenli = normalize(dosyaYolu).replace(/^(\.\.[/\\])+/, "");
    const dosya = join(ROOT, guvenli);
    if (
      !dosya.startsWith(ROOT) ||
      guvenli.startsWith("/.env") ||
      guvenli.includes("node_modules") ||
      guvenli.includes("duello-odalar")
    ) {
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
