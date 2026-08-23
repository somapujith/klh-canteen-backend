import type { OrderSummary } from "./realtime.js";

/** The shape createOrder() returns — enough of it to summarise for a broadcast. */
interface SummarisableOrder {
  id: string;
  orderNumber: number;
  status: string;
  kitchen: string;
  totalAmount: unknown;
  createdAt: Date | string;
  items: unknown[];
  studentId?: string | null;
  student?: { name?: string | null; rollNumber?: string | null } | null;
  guestName?: string | null;
  collectionAt?: Date | string | null;
  seenByAdmin?: boolean;
}

/**
 * Projects a freshly created order onto the realtime wire shape, so the board
 * can patch a row in place instead of refetching every order on the campus.
 */
export function toOrderSummary(order: SummarisableOrder): OrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    kitchen: order.kitchen as OrderSummary["kitchen"],
    totalAmount: Number(order.totalAmount).toFixed(2),
    itemCount: order.items.length,
    createdAt: new Date(order.createdAt).toISOString(),
    studentId: order.studentId ?? null,
    studentName: order.student?.name ?? null,
    rollNumber: order.student?.rollNumber ?? null,
    guestName: order.guestName ?? null,
    collectionAt: order.collectionAt ? new Date(order.collectionAt).toISOString() : null,
    seenByAdmin: order.seenByAdmin ?? false,
  };
}
