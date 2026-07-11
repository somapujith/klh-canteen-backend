import { Response } from "express";

export interface SSEEvent {
  type: string;
  data: any;
}

class SSEService {
  private clients: Map<string, Response[]> = new Map();

  // Add a new client connection
  addClient(userId: string, res: Response) {
    if (!this.clients.has(userId)) {
      this.clients.set(userId, []);
    }
    this.clients.get(userId)!.push(res);

    // Remove client on disconnect
    res.on("close", () => {
      this.removeClient(userId, res);
    });
  }

  private removeClient(userId: string, res: Response) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      const updatedClients = userClients.filter(client => client !== res);
      if (updatedClients.length === 0) {
        this.clients.delete(userId);
      } else {
        this.clients.set(userId, updatedClients);
      }
    }
  }

  // Send event to a specific user
  notifyUser(userId: string, event: SSEEvent) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      userClients.forEach(client => {
        client.write(payload);
      });
    }
  }

  // Broadcast event to ALL connected users
  broadcast(event: SSEEvent) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    this.clients.forEach(userClients => {
      userClients.forEach(client => {
        client.write(payload);
      });
    });
  }

  // Helpers for specific business events
  broadcastMenuUpdate() {
    this.broadcast({ type: "MENU_UPDATE", data: { timestamp: Date.now() } });
  }

  notifyOrderUpdate(studentId: string, orderId: string, status: string) {
    this.notifyUser(studentId, {
      type: "ORDER_UPDATE",
      data: { orderId, status, timestamp: Date.now() }
    });
  }
}

export const sseService = new SSEService();
