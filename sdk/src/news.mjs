// relayer/src/news.rs `message` ile aynı imza metni (EIP-191 personal_sign ile imzalanır).
import { keccak256, toBytes } from "viem";

export function message(poolId, ts, title, body, url) {
  const content = keccak256(toBytes(`${title}\n${body}\n${url}`));
  return `darkpool-news:v1\npool:${poolId}\nts:${ts}\ncontent:${content}`;
}
