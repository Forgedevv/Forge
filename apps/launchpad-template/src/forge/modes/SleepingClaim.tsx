import { ForgeWalletProvider } from '../AppProviders';
import { ClaimCreatorFees } from '../ClaimCreatorFees';

/**
 * LOCKED ZONE. The only interactive part of a sleeping site (decision D29): the creator fee claim
 * widget with its wallet connection. Loaded on demand by `SleepingPage` (its own chunk), so a
 * visitor who does not claim loads no wallet code and makes no RPC call. It renders the wallet
 * provider and the locked `ClaimCreatorFees`, nothing else: no data providers, no trade panel,
 * no coin creation, no indexer data. Every chain call goes through the FORGE RPC relay.
 */
export function SleepingClaim() {
  return (
    <ForgeWalletProvider>
      <div className="w-full max-w-xl text-left" data-forge="sleeping-claim">
        <ClaimCreatorFees />
      </div>
    </ForgeWalletProvider>
  );
}

export default SleepingClaim;
