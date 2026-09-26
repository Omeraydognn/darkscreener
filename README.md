# Dark Pool DEX

Faz 1: TEE çekirdeği (Rust) · Faz 2: Monad kontratları (Solidity) · Faz 3: shielded pool (Circom + Groth16) · Faz 4: relayer · Faz 5: frontend

```
tee-core/    Saf iş mantığı: ECIES, emir formatı, FM-AMM clearing, sealed state,
             drand tlock, batch işleme. Ağ / saat / dosya / TEE API YOK.
tee-attest/  TEE sağlayıcı wrapper'ı: TeeProvider trait (key_seed, trusted_unix_time, attest).
             Şu an: LocalDev. Sonra: Oyster, Nitro, Phala — çekirdeğe dokunmadan.
tee-server/  İkisini birleştiren HTTP sunucusu + dev-client (duman testi) + gen-fixture.
contracts/   DarkVault (shielded not ağacı, gizli emirler, zamana bağlı pencereler, shard'lı
             emir zincirleri, Merkle claim, kaçış kapağı) + OwnerEnclaveRegistry (yalnızca testnet).
circuits/    spend.circom (tek devre: emir + çekim), yerel Groth16 töreni, JS not/ağaç/kanıt kütüphanesi.
relayer/     Rust relayer: finalized-blok indexer, settler (yerel doğrulama sonrası settle),
             claimer (iade/claim otomatik), HTTP API (gizli emir + gazsız çekim gönderimi).
frontend/    Next.js 16 arayüz: ghost chart (7 gün gecikmeli), imzalı proje haberleri, tarayıcıda
             ZK kanıtlı gizli cüzdan (yatır / gizli al-sat / sonuç / gazsız çek).
sdk/         JS istemci: ECIES emir şifreleme, sonuç çözme, relayer istemcisi, anvil e2e senaryosu.
scripts/     setup.sh, gen-fixture.sh (Rust + Circom çapraz-uyum vektörü), e2e-local.sh (anvil).
```

## Çalıştırma

```bash
./scripts/setup.sh
cargo test --workspace
(cd circuits && npm test)
docker compose up -d --build enclave
docker compose run --rm smoke
(cd contracts && forge test)
(cd sdk && npm install && npm test)
./scripts/e2e-local.sh          # anvil + enclave + relayer + kullanıcı, uçtan uca
```

Frontend geliştirme (16 gün geriye alınmış yerel zincir; ilk ~9 gün gerçek drand ile açılmış,
son 7 gün kilitli — ghost chart ürünün göstereceği gibi dolar):

```bash
./scripts/dev-stack.sh          # ~10 dk seed, sonra açık kalır
npm --prefix frontend run dev   # http://localhost:3000
```

Monad testnet relayer:

```bash
cp .env.relayer.example .env.relayer   # doldur; git dışıdır
docker compose --profile relayer up -d
```

Rust ↔ Solidity uyumu `contracts/test/fixtures/e2e.json` ile test edilir; enclave formatı değişirse:

```bash
./scripts/gen-fixture.sh
```

Devre değişirse tören yeniden yapılmalı (verifier kontratı ve anahtarlar birlikte değişir):

```bash
./circuits/scripts/ceremony.sh && ./scripts/gen-fixture.sh
```

## HTTP

| Uç                 | Açıklama                                                        |
|--------------------|-----------------------------------------------------------------|
| `GET /health`      | canlılık                                                        |
| `GET /pubkey`      | emirlerin şifreleneceği anahtar + kontratın bekleyeceği adres   |
| `GET /attestation` | sağlayıcı belgesi (`local`: `format=none`, donanım garantisi yok) |
| `POST /process`    | batch işle; kilit turu enclave saatinden hesaplanır             |

Kurallar: kilit turu girdiden alınmaz; aynı `(batch_id, prev_state)` için tek emir kümesi imzalanır (farklısı 409).
