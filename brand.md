# Brand — darkscreener

_Status: active_ (yön: özgün araştırma terminali; ışık geçiren çaydan ilham alan dumanlı yüzeyler ve amber vurgular)

## İlke
Fiyat gizli, proje görünür. Arayüz canlı fiyat / işlem akışı göstermez; canlı olan tek şey
**proje haberleridir**. Gecikmeli veri her zaman "7 gün gecikmeli" etiketiyle, kilitli bölge
açıkça "karanlık" gösterilir.

## Palet (yalnızca koyu tema — terminal ürünü)
| Token | Değer | Kullanım |
|---|---|---|
| `--bg` | `#121110` | sayfa |
| `--panel` | `#1a1815` | panel/kart |
| `--panel-2` | `#25211c` | iç kart, hover |
| `--line` | `#3c342b` | kenarlık |
| `--fg` | `#f4eee5` | ana metin |
| `--muted` | `#b8aa99` | ikincil metin (panel üzerinde ≥ 4.5:1) |
| `--buy` | `#89b9a2` | alım / artış |
| `--sell` | `#d68571` | satım / düşüş |
| `--accent` | `#dba96a` | amber marka vurgusu, odak halkası |
| `--locked` | `#85827d` | gri temsili mumlar |
| `--warn` | `#dba96a` | uyarı |

## Tipografi
Geist Sans (arayüz), Geist Mono + `tabular-nums` (tüm sayılar, adresler).

## Ses
Kısa, net, Türkçe. "7 gün gecikmeli", "kilitli", "gizli" kelimeleri tutarlı kullanılır.

## Kilitli dönem
Son 7 gün eşit boyda sabit gri temsili mumlarla gösterilir. Bunlar fiyat, hacim veya getiri temsil etmez. Haber simgeleri yalnızca API tarafından sağlanan proje yayınlarından ve gerçek yayın tarihinden üretilir.
