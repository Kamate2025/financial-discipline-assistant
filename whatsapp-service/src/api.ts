import axios, { AxiosInstance } from "axios";

export interface DjangoUserSummary {
  currency: string;
  income_total: string;
  expense_total: string;
  net_cash_flow: string;
  income_count: number;
  expense_count: number;
  transfer_count: number;
}

export interface DjangoTransaction {
  id: number;
  description: string;
  activity_type: string;
  amount: string;
  currency: string;
  activity_date: string;
  owner: number;
  created_at: string;
  updated_at: string;
}

export class DjangoApiClient {
  private readonly client: AxiosInstance;

  constructor(baseURL: string, serviceKey: string) {
    if (!baseURL || !baseURL.startsWith("http")) {
      throw new Error("DJANGO_BASE_URL must be set to an HTTP URL before starting the WhatsApp service.");
    }

    if (!serviceKey) {
      throw new Error("DJANGO_SERVICE_KEY is required to authenticate with Django.");
    }

    this.client = axios.create({
      baseURL,
      headers: {
        "X-Service-Key": serviceKey,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
  }

  /**
   * Resolve a WhatsApp phone number to a Django user by calling the
   * transactions list endpoint. If the phone number is unknown, the
   * service key authentication will fail with 401.
   */
  async resolvePhone(phoneNumber: string): Promise<boolean> {
    try {
      await this.client.get("/api/v1/transactions/", {
        headers: { "X-WhatsApp-Phone": phoneNumber },
      });
      return true;
    } catch (error: any) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return false;
      }
      throw error;
    }
  }

  async recordTransaction(phoneNumber: string, payload: {
    description: string;
    activity_type: "INCOME" | "EXPENSE" | "TRANSFER";
    amount: string;
    currency: string;
    activity_date: string;
  }): Promise<DjangoTransaction> {
    const response = await this.client.post(
      "/api/v1/transactions/",
      payload,
      { headers: { "X-WhatsApp-Phone": phoneNumber } }
    );
    return response.data;
  }

  async getSummary(phoneNumber: string, startDate: string, endDate: string): Promise<DjangoUserSummary[]> {
    const response = await this.client.get("/api/v1/summaries/", {
      params: { start_date: startDate, end_date: endDate },
      headers: { "X-WhatsApp-Phone": phoneNumber },
    });
    return response.data;
  }

  async healthCheck(): Promise<{ status: string }> {
    const response = await this.client.get("/api/v1/health/");
    return response.data;
  }
}