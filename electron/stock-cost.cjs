// All public amounts are safe integer kopecks. BigInt intermediates avoid
// precision loss during weighted allocation. Ties round upward (half-up).
function integer(value, label = 'Сумма', positive = false) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) throw new Error(`${label}: требуется ${positive ? 'положительное' : 'неотрицательное'} целое число`)
  return number
}

function safe(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Стоимость или количество превышает допустимый диапазон')
  return number
}

function multiply(a, b) { return safe(BigInt(integer(a)) * BigInt(integer(b))) }
function sum(a, b) { return safe(BigInt(integer(a)) + BigInt(integer(b))) }
function allocate(total, quantity, units) {
  integer(total); integer(quantity, 'Остаток', true); integer(units)
  if (units > quantity) throw new Error('Недостаточный остаток')
  return safe((2n * BigInt(total) * BigInt(units) + BigInt(quantity)) / (2n * BigInt(quantity)))
}
function stock(quantity, total, fallback = 0) {
  integer(quantity, 'Остаток'); integer(total)
  if (!quantity && total) throw new Error('Стоимость пустого остатка должна быть нулевой')
  return { quantity, total, price: quantity ? allocate(total, quantity, 1) : integer(fallback, 'Цена') }
}
function receive(item, quantity, cost) {
  return stock(sum(item.quantity, quantity), sum(item.stock_cost, cost), item.purchase_price)
}
function take(item, quantity) {
  const cost = allocate(item.stock_cost, item.quantity, quantity)
  return { ...stock(item.quantity - quantity, item.stock_cost - cost, item.purchase_price), cost }
}
function adjust(item, quantity) {
  integer(quantity, 'Остаток')
  if (quantity <= item.quantity) return quantity === item.quantity ? stock(quantity, item.stock_cost, item.purchase_price) : take(item, item.quantity - quantity)
  return receive(item, quantity - item.quantity, multiply(quantity - item.quantity, item.purchase_price))
}
module.exports = { integer, multiply, sum, allocate, stock, receive, take, adjust }
