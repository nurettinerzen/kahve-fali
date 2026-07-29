# Kahve Falı — denetim sonrası yapılacaklar (28 Temmuz 2026)

## Durum
İki ajan denetledi ve düzeltti. 8 dosya **commit edilmedi**. `www/index.html` → `ios/App/App/public/index.html` kopyalandı, `diff` boş.

İyi haber: mağazaya giden kod ile kaynak senkrondu, `www/` içinde sağlayıcı gizli anahtarı yok, model adı geçerli, sözlük sağlam (47 sembol, bozuk/mükerrer yok), fincansız fotoğrafta jeton düşmüyor (gerçek istekle doğrulandı — model `fincan_mi:false` döndü, uydurma fal yazmadı).

## En ağır bulgular
**1. `/api/ses` metin uzunluk sınırı yoktu.** Gövde 8 MB'a kadar kabul ediliyor, `text` doğrulanmadan ElevenLabs'e gidiyordu — ElevenLabs **karakter başına** ücretlendirir. Gerçek bir fal ~1.131 karakter; sınır 8 milyon karaktere kadar açıktı. Canlı sunucuda kanıtlandı: `{"text":""}` bile **200 + mp3** döndürüyordu, yani boş metne bile fatura kesiliyordu. → 3000 karakter sınırı kondu. **Bu ancak Render'a deploy edilince kapanır.**

**2. Satın alınan jetonlar yalnızca `localStorage`'daydı.** Uygulama silinince ödenmiş jetonlar kalıcı kayboluyordu (para alındı, hizmet verilmedi) ve bedava hak yeniden kazanılıyordu. → **Sunucu jeton defteri yazıldı.** Doğrulandı: 20 jeton al → 1 harca → sil-kur → geri yükle → **19 jeton geri geldi**, ikinci geri yüklemede çoğalmadı.

**3. XSS**: model çıktısı (`b.baslik`, `b.metin`, `r.kapanis`) kaçırılmadan `innerHTML`'e basılıyordu. Capacitor WebView'ında çalışan script RevenueCat ve SignInWithApple eklentilerine erişebilirdi. → Düzeltildi, tarayıcıda kötü niyetli çıktı enjekte edilerek doğrulandı (0 eleman enjekte edildi, script çalışmadı).

**4. `/api/hesap-sil` IDOR**: `apple_sub` gövdeden geliyordu, sahiplik doğrulanmıyordu → `APP_KEY`'i olan herkes başkasının hesabını silebiliyordu. Ajan **aynı sınıftan ikinci bir açık** daha buldu: `/api/kayit` başkasının kaydına e-posta/ad yazmaya izin veriyordu. İkisi de kapatıldı.

## Diğer düzeltilenler
- **Apple kimlik jetonu doğrulaması bağımlılık eklemeden** yazıldı — `node:crypto`'nun `createPublicKey({format:"jwk"})` desteğiyle RS256 imza + `iss`/`aud`/`exp` + `alg=none` reddi. `jose` gerekmedi.
- Bakiye düşürme **iyimser kilitle (CAS)** — eşzamanlı iki istek tek jetonu iki kez harcayamıyor. Model hatasında, ses hatasında ve "fincan değil" yanıtında jeton **iade** ediliyor.
- **Satın alma hataları sessiz yutuluyordu** (`catch(e){}`) — ödeme reddinde/ağ hatasında kullanıcı hiçbir şey görmüyordu. Hata kodları RevenueCat'in kendi `errors.d.ts` dosyasından **birebir okundu** (tahmin yok): iptal (1) sessiz, "Ask to Buy" (20) bilgi mesajı + otomatik senkron, gerçek hatalar görünür.
- **"Satın alımları geri yükle" butonu** eklendi (hiç yoktu).
- **Fotoğraf küçültme + EXIF**: 1600px, JPEG 0,85. Doğrulandı: 3000×2000 → 1600×1067; EXIF Orientation=6 etiketli 200×100 görsel → **100×200** (dönme piksellere işlendi).
- **Gömülü fiyatlar kaldırıldı** (₺29/₺99/₺249) — `getProducts` başarısız olursa TR dışı kullanıcıya yanlış para birimi gösteriliyordu. Fiyat gelene kadar paketler dokunulamaz.
- **Fal geçmişi** eklendi (son 20, tek tek + toplu silinebilir) — eskiden "Yeni fal"a basınca ödenmiş fal kalıcı kayboluyordu.
- Hız sınırı `/api/kayit`, `/api/geribildirim`, `/api/hesap-sil` uçlarını **kapsamıyordu** (LIMITS'te yoktu) → sınırsız Supabase yazımı; düzeltildi.
- Sağlayıcı hata detayları (Anthropic `request_id`, ElevenLabs gövdesi) istemciye sızıyordu; `startRead`'de `catch` yoktu (sonsuz "bakıyor…" ekranı); ses butonuna ikinci basışta üst üste iki ses çalıyordu; bozuk `localStorage` kaydı açılışta `rcBaslat()`'ı öldürüp satın almayı tamamen çalışmaz hale getiriyordu; boş `bolumler` geçerli sayılıp jeton düşürüyordu — hepsi düzeltildi.
- Paywall'a Koşullar/Gizlilik linkleri, `NSPhotoLibraryUsageDescription`, CORS beyaz listesi, `#demo` hash'inin 5 jeton vermesi kapatıldı, yatay yönelim kapatıldı, jeton çekmecesi iPhone SE'de başlığı kesiyordu.

**54 test, 54'ü geçti.** İkinci turda ücretli Anthropic/ElevenLabs çağrısı **sıfır** (yerel taklit sunucu + sahte RevenueCat + gerçek RSA imzalı sahte Apple JWKS).

## Deploy sırası — bu sırayı bozma
**1. Supabase SQL Editor**: `fal-api.mjs:311-340` içindeki `create table` bloğunu çalıştır (`jeton_bakiye`, `jeton_islem` + indeksler + RLS). Tabloların `service_role` dışına açık olmadığını doğrula.

**2. Render → Environment**: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RC_SECRET` (RevenueCat **Secret** `sk_...`, `appl_` olan değil), `APPLE_CLIENT_ID=com.nurettinerzen.kahvefali`, **ayrıca geçici `HESAPSIL_ESKI_ISTEMCI=1`**.

**3. Sunucuyu deploy et.** Mağazadaki eski sürüm kırılmaz: `oturum` göndermediği için eski (istemci sayaçlı) davranışta kalır, hesap silme geçici bayrak sayesinde çalışır. `/health` `defter:true, magaza:true` dönmeli.

**4. Yeni build'i App Store'a gönder.** İlk açılışta `/api/oturum` yereldeki bakiyeyi bir kez sunucuya devrediyor (tavan 50) — ödenmiş jetonlar geçişte kaybolmuyor.

**5. Yeni sürüm yayılınca (~2-4 hafta) `HESAPSIL_ESKI_ISTEMCI`'yi Render'dan SİL.** IDOR ancak bu adımdan sonra tamamen kapanır.

Ters sırada (önce istemci) yaparsan yeni istemci var olmayan uçlara çağrı yapar ve sunucusuz kalır.

## RevenueCat
- **Secret key'i** (`sk_...`) al → Render `RC_SECRET`
- **Project settings → Restore Behavior**'ı kontrol et: **"Transfer purchases to the new App User ID"** olmalı. Olmazsa sil-kur sonrası geri yükleme makbuzu yeni kimliğe bağlayamaz ve jeton taşıması çalışmaz.

## App Store Connect
- **Gönderim notlarına** `pazarlama/app-store-listesi.md` içindeki İngilizce "DEMO PATH" bloğunu yapıştır (logoya 3 dokunuş). **Daha önce 2.1a reddi bunun yüzünden geldi** — fincanı olmayan reviewer yine takılır. Yol hâlâ çalışıyor ve ücret almıyor (doğrulandı).
- **App Availability** alanını kontrol et (onay çıksa da boşsa uygulama mağazada görünmez).
- `docs/gizlilik.html` güncellendi: uygulama içi silme + yeni saklanan veri (cihaz tanımlayıcısı, jeton bakiyesi).

## Xcode
`npx cap sync ios` (public/ kopyası güncel ama plugin/plist değişti), Info.plist'te portre kilidi ve build numarası artışını kontrol et.

## Cihazda test
1. **Sandbox'ta bir jeton paketi al**, sonra **sil-kur-geri yükle** akışını dene. Ajanın doğrulayamadığı tek şey bu.
2. Satın alma **iptali** → hata popup'ı çıkmamalı; **Ask to Buy** akışı
3. **Sessiz mod anahtarı açıkken** sesli dinleme — WKWebView sesi zil anahtarına takılıyor mu (jeton ödenip sessizlik riski)
4. Ses çalarken uygulamayı arka plana al / ekranı kilitle
5. Büyük/HEIC/yan çekilmiş fotoğrafla fal

## Kapatılamayanlar
- **Giriş yapmamış kullanıcı için bedava hak yeniden kazanılabilir** — cihaz kimliği localStorage'da, uygulama silinince değişiyor. DeviceCheck/App Attest olmadan tam çözülmez. **Satın alınan jetonlar korunuyor** (geri yükleme taşıması); kayıp yalnızca 1 bedava fal.
- Gerçek cihazda IAP denenmedi (Sandbox hesabı/cihaz gerekiyor).

## Temizlik
İlk tur denetimde yerel sunucu üzerinden Supabase `geri_bildirim` tablosuna ~10 adet `"deneme"` test kaydı yazıldı — silmek isteyebilirsin.
