function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round(Math.abs((d2 - d1) / msPerDay));
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString();
}

function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayISO() {
  return new Date().toISOString();
}

module.exports = {
  daysBetween,
  addDays,
  formatDate,
  todayISO
};
