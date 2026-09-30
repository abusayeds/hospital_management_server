export type TPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type TResponse<T> = {
  statusCode: number;
  success: boolean;
  message?: string;
  pagination?: TPagination;
  data: T;
};

export const buildPagination = (page: number, limit: number, total: number): TPagination => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});
