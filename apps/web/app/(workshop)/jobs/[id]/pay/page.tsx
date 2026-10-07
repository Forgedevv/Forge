import { PaymentScreen } from '@/ui/workspace/payment';
export const metadata = { title: 'Review payment — FORGE' };
export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaymentScreen jobId={id} />;
}
