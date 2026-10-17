export const faqCopy = {
  eyebrow: 'HELP',
  title: 'A clearer path to launch.',
  questions: [
    [
      'invite',
      'How do I get an invite?',
      'FORGE is in private beta: only invited wallets can sign in. Ask the FORGE team for an invite and include the wallet address you want to use. Once it is added, connect that wallet and sign in again.',
    ],
    [
      'support',
      'How do I contact the FORGE team?',
      'Use the contact below. Quote the reference shown on your payment or build page, and for a payment the transaction signature. The team never asks for your seed phrase or private key: never share them.',
    ],
    [
      'fees',
      'How do I claim my fees?',
      'Open your dashboard and choose “Claim my fees” on a launchpad. Review the amount and sign the claim in your wallet. The wallet shows the network fee before you sign.',
    ],
    [
      'coin',
      'Why does my coin not show up yet?',
      'Check the job tracker. Your launch transaction must be confirmed before the launchpad coin appears. If the job needs your signature, open the launch step from the tracker.',
    ],
    [
      'failure',
      'What if creation fails?',
      'A failed build is retried once automatically. After two failed build attempts, the creation payment is refunded. The tracker shows the confirmed refund. Failures during on-chain setup or deployment are handled by the team.',
    ],
    [
      'sleep',
      'What happens in sleep mode?',
      'An inactive launchpad enters sleep mode after the inactivity period. Open your dashboard and choose “Reactivate” to request its return.',
    ],
    [
      'changes',
      'Can I change my launchpad later?',
      'Yes. Open “Request a change” from the dashboard. The summary shows your remaining included changes and any payment is quoted before signing. On-chain fees, shares, and fee recipients are final.',
    ],
    [
      'forge-access',
      'How does the $FORGE balance check work?',
      'You hold the required amount; nothing is spent or locked. Before the token launches, access checking is disabled. An official acquisition link and token display metadata will be added when the service provides them. Do not use an unverified token address.',
    ],
  ],
} as const;
