/**
 * Sets up a testnet USDC distributor account.
 * Generates a keypair, funds it via friendbot, adds USDC trustline,
 * then acquires USDC by swapping XLM on the Stellar testnet DEX.
 *
 * Run: npx ts-node scripts/setup-usdc-distributor.ts
 */
import 'dotenv/config';
import * as S from '@stellar/stellar-sdk';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new S.Asset('USDC', USDC_ISSUER);
const XLM  = S.Asset.native();

const horizon = new S.Horizon.Server(HORIZON_URL);

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fund(publicKey: string) {
  console.log('  Funding via friendbot...');
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot failed: ${res.statusText}`);
  await sleep(3000);
}

async function addTrustline(kp: S.Keypair) {
  console.log('  Adding USDC trustline...');
  const acc = await horizon.loadAccount(kp.publicKey());
  const tx = new S.TransactionBuilder(acc, { fee: S.BASE_FEE, networkPassphrase: S.Networks.TESTNET })
    .addOperation(S.Operation.changeTrust({ asset: USDC, limit: '10000' }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

async function acquireUSDC(kp: S.Keypair, xlmToSpend = '50') {
  console.log(`  Swapping ${xlmToSpend} XLM → USDC on testnet DEX...`);
  const acc = await horizon.loadAccount(kp.publicKey());

  // pathPaymentStrictSend: spend up to xlmToSpend XLM, receive as much USDC as possible
  const tx = new S.TransactionBuilder(acc, { fee: S.BASE_FEE, networkPassphrase: S.Networks.TESTNET })
    .addOperation(
      S.Operation.pathPaymentStrictSend({
        sendAsset: XLM,
        sendAmount: xlmToSpend,
        destination: kp.publicKey(),
        destAsset: USDC,
        destMin: '0.0000001', // accept any amount
        path: [],
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(kp);
  try {
    await horizon.submitTransaction(tx);
    console.log('  DEX swap succeeded.');
  } catch (err: unknown) {
    // DEX may have no liquidity — fall back to manual instruction
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('op_no_path') || msg.includes('op_too_few_offers')) {
      console.log('  ⚠  No DEX liquidity for XLM→USDC on testnet right now.');
      console.log('  Manual fallback: go to https://laboratory.stellar.org/#txbuilder?network=test');
      console.log(`  Send USDC to: ${kp.publicKey()}`);
      console.log('  Or use https://testnet.stellar.quest/ faucet');
    } else {
      throw err;
    }
  }
}

async function checkBalance(publicKey: string) {
  const acc = await horizon.loadAccount(publicKey);
  type AnyBalance = S.Horizon.HorizonApi.BalanceLineAsset | S.Horizon.HorizonApi.BalanceLineNative | S.Horizon.HorizonApi.BalanceLineLiquidityPool;
  const usdc = (acc.balances as AnyBalance[]).find(
    (b) => b.asset_type !== 'native' && b.asset_type !== 'liquidity_pool_shares' &&
           (b as S.Horizon.HorizonApi.BalanceLineAsset).asset_code === 'USDC'
  ) as S.Horizon.HorizonApi.BalanceLineAsset | undefined;
  const xlm = (acc.balances as AnyBalance[]).find((b) => b.asset_type === 'native') as S.Horizon.HorizonApi.BalanceLineNative | undefined;
  return { xlm: xlm?.balance ?? '0', usdc: usdc?.balance ?? '0' };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   USDC Distributor Setup                 ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const kp = S.Keypair.random();
  console.log('Generated keypair:');
  console.log(`  Public : ${kp.publicKey()}`);
  console.log(`  Secret : ${kp.secret()}\n`);

  console.log('Step 1/3 — Fund with testnet XLM');
  await fund(kp.publicKey());

  console.log('Step 2/3 — Add USDC trustline');
  await addTrustline(kp);

  console.log('Step 3/3 — Acquire testnet USDC');
  await acquireUSDC(kp);

  const bal = await checkBalance(kp.publicKey());
  console.log(`\nFinal balances:`);
  console.log(`  XLM  : ${bal.xlm}`);
  console.log(`  USDC : ${bal.usdc}`);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Add this to your .env:                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\nTESTNET_USDC_DISTRIBUTOR_SECRET=${kp.secret()}\n`);

  if (parseFloat(bal.usdc) === 0) {
    console.log('⚠  USDC balance is 0. DEX had no liquidity.');
    console.log('   To get testnet USDC manually:');
    console.log('   1. Go to https://laboratory.stellar.org/#txbuilder?network=test');
    console.log('   2. Or ask in Stellar Discord #testnet-faucet');
    console.log(`   3. Send USDC to: ${kp.publicKey()}`);
    console.log('   Then re-run: npx ts-node scripts/setup-usdc-distributor.ts\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
