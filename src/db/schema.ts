/**
 * Hand-written model shapes, replacing @prisma/client's generated types.
 * Field names are 1:1 with column names (no @map/@@map existed in the old
 * Prisma schema), so this is a direct transcription of prisma/schema.prisma.
 *
 * Numeric/Decimal columns (price, totalAmount, priceAtOrder) come back as
 * `string` from the raw driver — Postgres `numeric` is not safely
 * representable as a JS number, and the codebase already treats these as
 * strings at its API boundary (e.g. `.toFixed(2)` reformatting, explicit
 * `String(...)` casts before insert).
 */

export type Role = "STUDENT" | "ADMIN" | "SUPERADMIN";
export type OrderStatus = "PENDING" | "PREPARING" | "COOKED" | "DELIVERED" | "CANCELLED";
export type Kitchen = "SNACKS" | "MEALS";
export type School = "KLH" | "DRK";

export interface User {
  id: string;
  role: Role;
  rollNumber: string | null;
  email: string;
  passwordHash: string;
  name: string;
  kitchen: Kitchen | null;
  school: School;
  createdAt: Date;
  mustChangePassword: boolean;
  isActive: boolean;
  tokensValidFrom: Date | null;
  telegramChatId: string | null;
  telegramUsername: string | null;
  telegramLinkedAt: Date | null;
  telegramLinkCode: string | null;
  telegramLinkExpiresAt: Date | null;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  kitchen: Kitchen;
}

export interface MenuItem {
  id: string;
  name: string;
  imageUrl: string;
  price: string;
  stockQty: number;
  reservedQty: number;
  isAvailable: boolean;
  categoryId: string;
}

export interface Order {
  id: string;
  studentId: string | null;
  guestSessionId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  status: OrderStatus;
  kitchen: Kitchen;
  token: string;
  orderNumber: number;
  totalAmount: string;
  createdAt: Date;
  collectionAt: Date | null;
  deliveredAt: Date | null;
  reservedAt: Date | null;
  reservationExpiresAt: Date | null;
  stockSettledAt: Date | null;
  seenByAdmin: boolean;
  seenAt: Date | null;
  lockedByAdminId: string | null;
  lockedAt: Date | null;
}

export interface CollectionWindow {
  id: string;
  startAt: Date;
  kitchen: Kitchen;
  capacity: number;
  bookedCount: number;
  createdAt: Date;
}

export interface OrderItem {
  id: string;
  orderId: string;
  menuItemId: string;
  quantity: number;
  priceAtOrder: string;
}

export interface AuditLog {
  id: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: Date;
}
