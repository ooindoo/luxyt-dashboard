async function fetchOverview() {
  const res = await fetch('/api/analytics/overview');
  if (!res.ok) return;
  const data = await res.json();

  document.getElementById('app').innerHTML = `
    <section class="overview">
      <div class="card">
        <span class="label">Visitors</span>
        <span class="value">${data.visitors.toLocaleString()}</span>
      </div>
      <div class="card">
        <span class="label">Page Views</span>
        <span class="value">${data.pageviews.toLocaleString()}</span>
      </div>
      <div class="card">
        <span class="label">Bounce Rate</span>
        <span class="value">${data.bounceRate}%</span>
      </div>
      <div class="card">
        <span class="label">Avg. Session</span>
        <span class="value">${data.avgSession}</span>
      </div>
    </section>
  `;
}

fetchOverview();
