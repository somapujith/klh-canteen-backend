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
  /** Google's stable `sub` claim. The identity key for Google sign-in — not
   *  email, which a user can change on their Google account. DRK students only. */
  googleId: string | null;
  /** Verified email Google returned at (re-)link time. May drift from `email`. */
  googleEmail: string | null;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  kitchen: Kitchen;
  /** Soft delete, for the same reason as MenuItem.isArchived — MenuItem's FK
   *  to Category is ON DELETE RESTRICT. Archiving a category archives its
   *  items with it. */
  isArchived: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  /** Deprecated fallback — pasted-URL images predate uploads. */
  imageUrl: string | null;
  /** sha256 of the stored MenuItemImage bytes (32 hex chars), or null. */
  imageHash: string | null;
  price: string;
  stockQty: number;
  reservedQty: number;
  isAvailable: boolean;
  /**
   * Soft delete. `isAvailable` is the reversible "sold out today" toggle;
   * this is the terminal state the admin delete button produces, since
   * OrderItem's ON DELETE RESTRICT FK makes a real DELETE impossible for any
   * item that has ever been ordered. Archived items are excluded from every
   * menu and inventory read, but stay joinable from order history.
   */
  isArchived: boolean;
  categoryId: string;
}

export interface MenuItemImage {
  menuItemId: string;
  bytes: Uint8Array;
  mimeType: "image/webp" | "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
  /** Nullable: ON DELETE SET NULL when the uploading user is later deleted — see 20260828130000_menu_item_image_uploader_nullable. */
  uploadedById: string | null;
  createdAt: Date;
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

/**
 * A student asking to be told when a sold-out item is back. At most one row
 * per (menuItemId, studentId) — see the migration for why the count depends
 * on that. Cleared once the admin sends the restock notification.
 */
export interface StockRequest {
  id: string;
  menuItemId: string;
  studentId: string;
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
