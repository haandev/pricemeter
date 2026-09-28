# Ölçülü Fiyatlandırma Motoru

Sep 28, 2026 · @Hakan

> Tasarım belgesinin repo kopyası. Uygulama sırasında alınan kararlar `design/decisions.md` (A77–) içindedir; çelişkide o dosya geçerlidir.

## 1. Amaç ve sınır

`pricemeter`, **"ne kadar"** sorusunun tek sahibi olan aptal bir TypeScript kütüphanesidir. Uygulama tarifeyi ve şimdiye kadarki kullanımı verir; kütüphane tutarı hesaplar ve ne yazılacağını söyler. "Ne zaman", "nerede", "kim" soruları — sayma, saklama, takvim, tampon, kuyruk, bakiye, HTTP, UI — tamamen uygulamanındır. Görüşlü bir ürün (Lago benzeri, ya da Cellonay'in kendi faturalama katmanı) bunun üstüne yazılır.

**Devredilemez çekirdek** (bunlar giderse fiyat motoru olmaktan çıkar):

- Tarife (`Rate`) şekli ve doğrulaması.
- `rate()`: üç model, `per`, kademe sabit ücreti, yuvarlama, tavan/taban, hacim düzeltmesi, hold üst sınırı.
- Dönem içi konum: `usedSoFar` ile kademe bölme.
- Plan üretimi: idempotent `refId`'li ledger + usage satırları.
- Katalog ilişkileri: tip güvenli sayaç id'leri, boyut şemaları, havuz beslemesi (`feeds`).

**Kapsam içi:** katalog, tarife, `rate()`, `price()`, `observe/hold/capture/release`, plan; opsiyonel modüller; bellek içi, SQLite, Cloudflare referans adapter'ları; üç örnek + tarifler; docs sitesi.

**Kapsam dışı:** fiyat tablosu ve sürümleme (uygulamanın; `/rates` modülü isteğe bağlı), takvim, dönem kapanışı, sayaçlar, tampon, kuyruk, bakiye kapısı (commit'in içi), fatura, vergi, ödeme, abonelik, kupon, kur, admin UI, HTTP, zamanlayıcı, raporlama (§11).

**Giriş testi.** Bir şey çekirdeğe girer ancak: (1) gözlem → tutar → plan zincirinde bir adımsa; (2) `Rate` ya da katalog verisiyle ifade ediliyorsa ya da saf hesaplamaysa; (3) üç örnekten en az ikisinde gerekiyorsa.

**Modül testi.** Modül çekirdeğe yalnızca dört dikişten girer: `getRate` üretmek, gözlem miktarı üretmek, plan kalemi üretmek, saf hesap. Dördünün dışına çıkmak zorunda kalan modül ya çekirdekte gerçek bir eksik bulmuştur (çekirdeğe girer, Ek A'ya karar olur) ya yanlış tasarlanmıştır.

**Neden mevcut bir platform değil.** Lago, Orb, Metronome, OpenMeter ayrı servislerdir. Bu paket senkron prepaid kapı, Cloudflare DO içinde atomik yazım, fatura dışı kapsam ve kodda tip güvenli katalog için gömülüdür. Platformlar referanstır; kapsama karşılaştırması Ek B'de.

## 2. Kavram modeli

Veri akışı: iki giriş (tarife + kullanım, gözlem), iki çıkış (sonuç, plan).

| Kavram | Tanım |
| --- | --- |
| **Meter** | Katalogda bir id ve boyut şeması; isteğe bağlı `feeds` (havuz besleme). Tipi, birimi, politikası yoktur |
| **Dimension** | Boyut şemasından (Standard Schema) türeyen tipli değerler; string, sayı, enum olabilir. Joker yoktur |
| **Line** | Bir gözlem satırı: `{ meter, dims, quantity }`; `observe` bir ya da çok satır alır |
| **Rate** | O anki tarife: model, kademeler, politika; `getRate` döner. Sürüm, scope, geçerlilik tarihi taşımaz; onlar uygulamanın |
| **usedSoFar** | Bu hesabın bu sayaçta bu dönemde şimdiye kadarki adedi; kademe bölme için. `getRate` ile gelir, çağrıda ezilebilir |
| **Ctx** | Uygulamanın bağlamı (şema ile tipli); metering yalnızca `accountId` okur, gerisini `getRate`'e iletir |
| **Ref** | `{ type, id }`; `refType` katalogda şemalı; idempotensi anahtarı |
| **Hold** | Çok satırlı rezervasyon; tarife ve `usedSoFar` içine gömülü bir değer nesnesi; uygulama saklar |
| **Plan** | `{ ledger: LedgerOp[]; usage: UsageRow[] }`; metering'in tek çıktısı |
| **Result** | `{ ok: true, charged, lines[] }` ya da `{ ok: false, reason }` |

**Üç durum:** tarife 0 fiyatlı = ücretsiz ve fiyatlı (sayılır, 0 yazılır); `getRate` `null` = fiyat yok → `ifMissing` (varsayılan `reject`); `reject` = `{ ok: false, reason: "no_price" }`, hiçbir şey yazılmaz.

## 3. Katalog: `buildMetering`

Tek nesne, tek zincir, `build()` yok. Her adım aynı nesneyi döndürür ama dönüş tipini daraltır (`as`); çağıran her zaman dönen referansı kullanır.

```ts
import { buildMetering } from "pricemeter";
import { z } from "zod";

export const metering = buildMetering()
  .context(z.object({ accountId: z.string(), plan: z.enum(["free", "pro"]), periods: z.object({ month: z.string() }) }))
  .refs(z.enum(["otp_send", "otp_verify", "window", "period"]))
  .meter("msg/free_pool")                                                              // havuz: sıradan sayaç, önce tanımlanır
  .meter("otp/sms",      { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
  .meter("otp/whatsapp", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
  .meter("llm/credits")
  .meter("llm/output",   { model: z.string() }, { feeds: { "llm/credits": (d) => d.model === "opus" ? 5 : 3 } })
  .meter("cc/conversation", { tier: z.enum(["short", "medium", "long"]) })
  .getRate(async (meter, dims, ctx, at) => { /* uygulamanın tablosu */ })
  .commit(async (plan) => { /* uygulamanın transaction'ı */ });

metering.meters   // { "otp/sms": { dims: ["country"], feeds: ["msg/free_pool"] }, ... } — düz, serileştirilebilir
```

| Adım | Ne yapar | Tip etkisi |
| --- | --- | --- |
| `.context(schema \| <T>)` | Bağlam şeması; her çağrıda doğrulanır (`{ validate: "never" }` ile kapatılır) | `Ctx` |
| `.refs(schema \| <T>)` | `refType` kümesi | `Ref.type` birliği |
| `.meter(id, dims?, opts?)` | Sayaç; `dims` üç biçimde: Standard Schema nesnesi (tipli + runtime doğrulama), düz tip parametresi (tipli, doğrulama yok), ya da eski usul anahtar dizisi `["country"]` (değerler `any`, doğrulama yok); `opts.feeds`: havuz id → sayı ya da `(dims, ctx) => number` | `MeterId`'ye ekler, `DimsOf<id>` türetir; `feeds` yalnızca önce tanımlanmış id'leri alır, havuza `feeds` verilemez |
| `.getRate(fn)` | `(meter, dims, ctx, at) => { rate; usedSoFar? } \| null`; `meter` üzerinden ayrışan `dims` tipi | `Bound` bayrağı |
| `.commit(fn)` | `(plan) => void`; fırlatırsa `commit_failed`, `InsufficientCredit` fırlatırsa `insufficient_credit` | `Bound` bayrağı |

Her zaman var: `meters`, `price()`, `validateRate()`. İkisi de verilince (`Bound`): `observe`, `hold`, `capture`, `release`. Verilmeden `observe` çağırmak derleme hatası. Aynı tanımı başka adapter'larla bağlamak: `metering.bind({ getRate, commit })` yeni bağlı kopya döner.

Katalogda olmayanlar ve nedeni: `unit` (sunum), `type` (gözlem şekli tek: miktar), `aggregation`/`period`/`chargeTiming`/`batch` (uygulamanın zamanı), `missingPolicy` (`observe` seçeneği), `holdable` (her sayaç hold alabilir), `costBearing`/`counted` (uygulama meta'sı). Standard Schema: `zod`, `valibot`, `arktype`; lib bağımlılık almaz, `~standard.validate` çağırır.

## 4. Tarife (`Rate`) ve `usedSoFar`

`getRate` o anki **tarifeyi** döner — tek bir birim fiyat değil, kademelerin tamamı. Hangi kademede olunduğunu ve bir gözlemin kademeler arasında nasıl bölüneceğini `getRate` değil `rate()` belirler (`usedSoFar 9990`, `quantity 20` → 10 birim eski, 10 birim yeni fiyattan). Sürüm, scope, geçerlilik tarihi, tarihçe uygulamanın tablosunda yaşar ve lib'e görünmez. Hangi ana göre fiyat (olay anı, hesap anı, verilen bir an) `getRate`'i yazanın kararıdır; lib `at`'i iletir, yorumlamaz.

```ts
interface Rate {
  model: "graduated" | "volume" | "package";
  tiers: Tier[];                         // ilk from = 0, from kesin artan
  packageSize?: number;                  // yalnızca package
  policy?: {
    rounding?: "per_event_up" | "cumulative";            // varsayılan per_event_up
    adjustmentTiming?: "on_crossing" | "none";           // yalnızca volume; varsayılan none
    perObservation?: { minMicroUsd?: number; maxMicroUsd?: number };
    tierPeriod?: string;                                  // usedSoFar'ın hangi dönem anahtarına ait olduğu; getRate'e ipucu, lib yorumlamaz
  };
  id?: string;                           // usage satırına yazılır; hangi tarifeden geldiği izlenir
}
interface Tier { from: number; unitPriceMicroUsd: number; per?: number; flatMicroUsd?: number }   // per varsayılan 1
```

**Üç model yeter:** tek birim fiyat = tek kademeli `graduated`; sabit ücret = tek kademe `flatMicroUsd`, birim 0; yüzde = `quantity` işlem tutarı, `per: 1_000_000`; oranlama = `per` ile ölçek (koltuk-saniye / ay-saniye). `flatMicroUsd` kademeye ilk girişte bir kez eklenir. Bir tarife tek model taşır; bileşiklik kademe alanlarından ve çok satırlı `observe`'dan gelir, iç içe tarife yoktur.

**`validateRate`:** ilk kademe `from = 0`; `from` kesin artan; fiyatlar ≥ 0 tamsayı; `per ≥ 1`; ~~`graduated` artmayan fiyatlı~~ (A79); `packageSize ≥ 1`; `adjustmentTiming` yalnızca volume; `min ≤ max`. Hatalar `{ code, path, message }`. `getRate` ham obje dönebilir, lib doğrular; doğrudan `price()` çağıran `ValidRate` (branded) vermek zorundadır.

**`usedSoFar`:** çok kademeli, `package` ve `volume` tarifelerde zorunlu — olay kademe sınırını aşabilir ve bölmeyi `rate()` yapar. `getRate` ile gelir; çağrıdaki `{ usedSoFar }` onu ezer (DO içi hesap). Tek kademeli tarifede istenmez (A82 istisnaları). Eksikse `{ ok: false, reason: "usage_required" }`; lib sessizce 0 varsaymaz.

## 5. `rate()` ve `price()`

İkisi de saf; adapter yok, I/O yok. `price()` lib'in gerçek çekirdeğidir; `observe` yalnızca "getRate çek → price → commit" sarmalayıcısıdır. Görüşlü bir ürün `price()`'ı kullanır, `observe`'u görmez.

| Model | Hesap | Örnek: `usedSoFar 9990`, `quantity 20`, kademeler `[0: 50000, 10000: 45000]` |
| --- | --- | --- |
| `graduated` | dilimler kendi fiyatından; kademeye ilk girişte `flatMicroUsd` | 10×50000 + 10×45000 = 950.000 |
| `volume` | tüm miktar, sonda bulunulan kademe fiyatından; `on_crossing` ise önceki adetler için negatif kalem | 20×45000 = 900.000; düzeltme −9990×5000 |
| `package` | `ceil((u+q)/size) − ceil(u/size)` yeni blok × blok fiyatı | size 1000 → 1 blok |

**Yuvarlama:** `per_event_up` gözlem başına yukarı; `cumulative` `floor(rate(u+q)) − floor(rate(u))`, dönem toplamı sapmasız, `carry` ile (LLM token için). **Tavan/taban:** gözlem tutarı `[min, max]`'a kırpılır, `clamped` işaretlenir. **Hold üst sınırı:** A80. **Para:** `MicroUsd` branded tamsayı `number`; 2^53 mikro-USD ≈ 9 milyar USD.

`refId` kuralı: satır başına `{refType}:{ref.id}:{meter}`; hacim düzeltmesi `...:adj`; havuz satırı `...:{poolMeter}`. Aynı `(refType, refId)` ikinci kez gelirse `commit` no-op yapmalıdır; bu uygulama retry'ını güvenli kılar.

## 6. `observe`, `hold`, `capture`, `release`

Hepsi bağlı nesnede; her biri satırları genişletir (`feeds`), `getRate` çeker, `price()` çağırır, `commit` eder, `result` döner. Plan görmek isteyen `metering.plan.observe(...)` kullanır: aynı imza, `commit` yok, `{ result, plan }` döner.

| Seçenek | Anlamı | Varsayılan |
| --- | --- | --- |
| `at` | gözlem zamanı; `getRate`'e ve usage satırına gider | `Date.now()` |
| `usedSoFar` | `getRate`'inkini ezer (tek satırda sayı, çok satırda `meter → sayı`) | — |
| `ifMissing` | `getRate` null dönerse: `reject` (yazma, `no_price` döner) ya da `free` (0 ile say ve yaz) | `reject` |
| `feeds` | `false`: havuz genişletmesi yapma | `true` |

**Havuz genişletme:** katalogda `feeds` olan sayaç için lib havuz satırını ekler: `quantity × weight(dims)`, `ceil`. Havuz satırı kendi `getRate`'ini alır. Aynı havuz satırını elle de verirsen lib ikinci kez eklemez. Log'da `detail.feeder`, `detail.weight`.

**Hold:** `hold` bir değer nesnesidir; uygulama saklar, lib ledger'dan okumaz. Capture-anı fiyatı isteyen `capture(hold, lines, ctx, { rate })` verir. Kısmi ve tekrarlı capture serbest; toplam üst sınırı aşamaz.

**Bakiye kapısı lib'de değildir.** "Bakiye ≥ tutar" kontrolü ile yazım aynı atomik sınırda olmazsa yarış vardır; bunu yalnızca ledger yapabilir. `commit` `InsufficientCredit` fırlatır, lib `insufficient_credit` döner. Postpaid = commit hiç fırlatmaz.

## 7–11

Tarifler (§7), modüller (§8), adapter'lar (§9), örnekler/test/docs/paket (§10) ve kapsam dışı (§11) docs sitesinde birer sayfa olarak yaşar; özgün tablolar orada korunmuştur. Karar kaydı Ek A (A53–A76) ve senaryo matrisi Ek B (B1–B27, L1–L11) için bkz. docs → Kararlar ve `examples/recipes`.

### D — Açık sorular (kapandı)

| # | Soru | Karar |
| --- | --- | --- |
| D7 | Docs alan adı ve erişim | bun workspaces monorepo (paket + docsite); docsite Astro, GitHub Pages; paket npm |
| D16 | Takvim yardımcıları | `/calendar` modülü (A72) |
| D17 | Bağlam doğrulaması | her çağrı (A73) |
| D18 | `feeds` fonksiyonu `ctx` görsün mü | evet (A74) |
