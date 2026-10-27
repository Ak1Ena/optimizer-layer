import { weekOf } from './week.mjs';

export function ordersByWeek(orders) {
  const weeks = {};
  for (const order of orders) (weeks[weekOf(order.at)] ??= []).push(order.id);
  return weeks;
}
