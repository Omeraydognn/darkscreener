# Enclave'i Marlin Oyster CVM'e taşımak

Şu an testnet enclave'i `TEE_PROVIDER=local` ile operatörün makinesinde çalışıyor: kriptografi,
ZK ve zaman kilidi gerçek, ama operatör teorik olarak emirleri görebilir. Oyster'da enclave
anahtarı **kod imajına bağlı KMS'ten** gelir; operatör dahil kimse göremez ve herkes doğrulayabilir.

Oyster ödemesi **Arbitrum One** üzerinde yapılır (gerçek USDC + az ETH). Bu adımları cüzdan
sahibi yapar; anahtarınızı kimseyle paylaşmayın.

## 1. İmajı derle ve yayınla (linux/amd64)

```bash
docker buildx build --platform linux/amd64 -t <kullanıcı>/darkpool-enclave:v1 --push .
docker buildx imagetools inspect <kullanıcı>/darkpool-enclave:v1   # Digest: sha256:...
```

`oyster/docker-compose.yml` içinde `image:` satırını `<kullanıcı>/darkpool-enclave@sha256:<digest>`
yapın ve `RELAYER_ADDRESSES`'e relayer adresini yazın (`./scripts/testnet.sh status`).

## 2. Deploy

```bash
oyster-cvm deploy --wallet-private-key "$ARB_KEY" --duration-in-minutes 1440 \
  --docker-compose oyster/docker-compose.yml --arch amd64
```

Çıktıdaki **enclave IP** ve **image id**'yi not edin.

## 3. Doğrula ve kaydet

```bash
oyster-cvm verify --enclave-ip <IP> --image-id <IMAGE_ID>
oyster-cvm kms-derive --image-id <IMAGE_ID> --path darkpool-enclave-v1 --key-type secp256k1/address
curl http://<IP>:8080/pubkey      # address, kms-derive çıktısıyla AYNI olmalı; hardware_backed: true
```

Aynıysa yeni enclave'i kaydedip eskisini kaldırın (deployer = registry sahibi):

```bash
cast send <REGISTRY> "register(address,bytes32)" <ENCLAVE_ADDRESS> <IMAGE_ID> --rpc-url https://testnet-rpc.monad.xyz --private-key "$DEPLOYER_KEY"
cast send <REGISTRY> "revoke(address)" <ESKİ_LOCAL_ENCLAVE> --rpc-url https://testnet-rpc.monad.xyz --private-key "$DEPLOYER_KEY"
```

## 4. Relayer'ı yeni enclave'e bağla

`.testnet/relayer.env` içinde `ENCLAVE_URL=http://<IP>:8080` yapıp relayer'ı yeniden başlatın.

**Önemli — geçiş anı:** Zincirdeki sealed state eski (local) anahtarla şifreli; yeni enclave onu
açamaz. Geçişi deploy'dan hemen sonra, hiç batch settle edilmeden yapın ya da yeni bir vault
deploy edin. Kullanıcıların bu durumda fonları kaçış kapağıyla (2 gün) güvende kalır.

## Kim neyi doğrular

| Soru | Nasıl |
|---|---|
| Çalışan kod bu repo mu? | image id = compose + imaj digest'i; imajı kendiniz derleyip digest'i karşılaştırın |
| Makine gerçek Nitro enclave mi? | `oyster-cvm verify` (AWS kök sertifikasına kadar zincir) |
| Emirler bu enclave'e mi şifreleniyor? | `kms-derive` adresi = registry'deki adres = `/pubkey` |
