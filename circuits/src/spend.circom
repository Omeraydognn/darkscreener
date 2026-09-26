pragma circom 2.2.0;

// Dark Pool shielded pool — tek "spend" devresi.
//
// Hem gizli emirde (submitShieldedOrder) hem çekimde (withdraw) kullanılır:
//   - Ağaçta sahip olunan bir notu harcar (nullifier yayınlanır),
//   - `spendAmount` kadarını `spendCommitment` olarak dışarı verir,
//   - kalanını aynı sahibe yeni bir not (`changeCommitment`) olarak geri koyar.
//
// Not:          commitment = Poseidon3(token, amount, Poseidon2(owner, blinding))
// Sahip:        owner      = Poseidon1(spendKey)
// Nullifier:    nullifier  = Poseidon2(spendKey, commitment)
// Harcanan:     spendCommitment = Poseidon3(token, spendAmount, spendBlinding)
//
// Emirde spendCommitment'ın açılışı (token, miktar, spendBlinding) yalnızca enclave'e
// şifreli gider; çekimde açılış zincire verilir. `ctxHash` kanıtı çağrı bağlamına
// (ciphertext veya alıcı) bağlar: mempool'dan kopyalanan kanıt başka bağlamda geçersizdir.
//
// Rust karşılığı: tee-core/src/note.rs · Solidity: contracts/src/lib/NoteLib.sol

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Poseidon2 ile soldan dolu Merkle ağacı; yol yönü leafIndex bitlerinden türetilir.
template MerkleRoot(levels) {
    signal input leaf;
    signal input leafIndex;
    signal input pathElements[levels];
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== leafIndex;

    component mux[levels];
    component hashers[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== cur[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== cur[i];
        mux[i].s <== bits.out[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[levels];
}

template Spend(levels) {
    // ---- açık girdiler (bu sırayla: kontrattaki publicSignals dizisi)
    signal input root;
    signal input nullifier;
    signal input changeCommitment;
    signal input spendCommitment;
    signal input ctxHash;

    // ---- gizli girdiler
    signal input token;
    signal input amount;
    signal input spendKey;
    signal input blinding;
    signal input leafIndex;
    signal input pathElements[levels];
    signal input spendAmount;
    signal input spendBlinding;
    signal input changeBlinding;

    // Tutarlar 128 bit; change'in de 128 bite sığması spendAmount <= amount demektir.
    component amountBits = Num2Bits(128);
    amountBits.in <== amount;
    component spendBits = Num2Bits(128);
    spendBits.in <== spendAmount;
    signal change <== amount - spendAmount;
    component changeBits = Num2Bits(128);
    changeBits.in <== change;

    component owner = Poseidon(1);
    owner.inputs[0] <== spendKey;

    component secret = Poseidon(2);
    secret.inputs[0] <== owner.out;
    secret.inputs[1] <== blinding;

    component note = Poseidon(3);
    note.inputs[0] <== token;
    note.inputs[1] <== amount;
    note.inputs[2] <== secret.out;

    component tree = MerkleRoot(levels);
    tree.leaf <== note.out;
    tree.leafIndex <== leafIndex;
    tree.pathElements <== pathElements;
    tree.root === root;

    component nf = Poseidon(2);
    nf.inputs[0] <== spendKey;
    nf.inputs[1] <== note.out;
    nf.out === nullifier;

    component changeSecret = Poseidon(2);
    changeSecret.inputs[0] <== owner.out;
    changeSecret.inputs[1] <== changeBlinding;
    component changeNote = Poseidon(3);
    changeNote.inputs[0] <== token;
    changeNote.inputs[1] <== change;
    changeNote.inputs[2] <== changeSecret.out;
    changeNote.out === changeCommitment;

    component spent = Poseidon(3);
    spent.inputs[0] <== token;
    spent.inputs[1] <== spendAmount;
    spent.inputs[2] <== spendBlinding;
    spent.out === spendCommitment;

    // ctxHash hiçbir hesaba girmez; kare kısıtı optimizer'ın onu atmasını engeller,
    // böylece Groth16 kanıtı ona bağlı kalır.
    signal ctxSquare <== ctxHash * ctxHash;
}

component main {public [root, nullifier, changeCommitment, spendCommitment, ctxHash]} = Spend(20);
