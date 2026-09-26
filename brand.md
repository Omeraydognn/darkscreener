# Brand — darkscreener

_Status: active_ — **varsayılan açık tema**, başlıktaki düğmeyle koyu tema (`<html data-theme="dark">`, tercih localStorage'da). Değerler `frontend/app/globals.css` içindeki iki `:root` bloğundadır; aşağıdaki tablo koyu temadır. Açık tema: bg `#f4f6f9`, panel `#ffffff`, fg `#0f141a`, muted `#56606c`, buy `#03a66d`, sell `#d9304e`, accent `#4f5bd5`. En küçük yazı 10 px. (yön: özgün araştırma terminali; nötr grafit yüzeyler, canlı yeşil/kırmızı mumlar ve indigo vurgu)

## İlke
Fiyat gizli, proje görünür. Arayüz canlı fiyat / işlem akışı göstermez; canlı olan tek şey
**proje haberleridir**. Gecikmeli veri her zaman "7 gün gecikmeli" etiketiyle, kilitli bölge
açıkça "karanlık" gösterilir.

## Palet (yalnızca koyu tema — terminal ürünü)
| Token | Değer | Kullanım |
|---|---|---|
| `--bg` | `#0b0e11` | sayfa |
| `--panel` | `#161a1e` | panel/kart |
| `--panel-2` | `#1e2329` | iç kart, hover |
| `--line` | `#2b3139` | kenarlık |
| `--fg` | `#eaecef` | ana metin |
| `--muted` | `#9aa3ae` | ikincil metin (panel üzerinde ≥ 4.5:1) |
| `--buy` | `#0ecb81` | alım / artış |
| `--sell` | `#f6465d` | satım / düşüş |
| `--accent` | `#7b8cff` | indigo marka vurgusu, odak halkası (mumlarla çakışmaz) |
| `--locked` | `#5e6673` | kilitli alanlar; gizli dönem mumları `--ghost: #f5f7fa` (beyaz) |
| `--warn` | `#f0b90b` | uyarı |

## Tipografi
Geist Sans (arayüz), Geist Mono + `tabular-nums` (tüm sayılar, adresler).

## Ses
Kısa, net, Türkçe. "7 gün gecikmeli", "kilitli", "gizli" kelimeleri tutarlı kullanılır.

## Kilitli dönem
Son 7 gün eşit boyda sabit gri temsili mumlarla gösterilir. Bunlar fiyat, hacim veya getiri temsil etmez. Haber simgeleri yalnızca API tarafından sağlanan proje yayınlarından ve gerçek yayın tarihinden üretilir.
