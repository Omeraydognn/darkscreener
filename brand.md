# Brand — darkscreener

_Status: active_ (yön: özgün araştırma terminali; siyah yüzeyler ve canlı kırmızı vurgular)

## İlke
Fiyat gizli, proje görünür. Arayüz canlı fiyat / işlem akışı göstermez; canlı olan tek şey
**proje haberleridir**. Gecikmeli veri her zaman "7 gün gecikmeli" etiketiyle, kilitli bölge
açıkça "karanlık" gösterilir.

## Palet (yalnızca koyu tema — terminal ürünü)
| Token | Değer | Kullanım |
|---|---|---|
| `--bg` | `#0a0a0a` | sayfa |
| `--panel` | `#131313` | panel/kart |
| `--panel-2` | `#1d1d1d` | iç kart, hover |
| `--line` | `#2e2e2e` | kenarlık |
| `--fg` | `#f5f5f5` | ana metin |
| `--muted` | `#a8a8a8` | ikincil metin (panel üzerinde ≥ 4.5:1) |
| `--buy` | `#89b9a2` | alım / artış |
| `--sell` | `#ff6b7a` | satım / düşüş |
| `--accent` | `#ff1f3d` | canlı kırmızı marka vurgusu, odak halkası |
| `--locked` | `#7c7c7c` | gri temsili mumlar |
| `--warn` | `#f5b83d` | uyarı |

## Tipografi
Geist Sans (arayüz), Geist Mono + `tabular-nums` (tüm sayılar, adresler).

## Ses
Kısa, net, Türkçe. "7 gün gecikmeli", "kilitli", "gizli" kelimeleri tutarlı kullanılır.

## Kilitli dönem
Son 7 gün eşit boyda sabit gri temsili mumlarla gösterilir. Bunlar fiyat, hacim veya getiri temsil etmez. Haber simgeleri yalnızca API tarafından sağlanan proje yayınlarından ve gerçek yayın tarihinden üretilir.
