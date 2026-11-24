
/* =================================
   SAHDONG - MAIN JAVASCRIPT
   ================================= */

document.addEventListener("DOMContentLoaded", function () {
  console.log("SAHDONG berhasil dimuat!");

  // Tahun otomatis pada footer
  const yearElement = document.querySelector("[data-year]");

  if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
  }
});
