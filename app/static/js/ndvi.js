(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const num = params.get("num") || "";
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  $("numParcel").value = num;
  $("startDate").min = "2019-01-01";
  $("endDate").max = todayIso;
  $("endDate").value = todayIso;
  const defaultStart = new Date(today); defaultStart.setDate(defaultStart.getDate() - 30);
  $("startDate").value = `${defaultStart.getFullYear()}-${String(defaultStart.getMonth()+1).padStart(2,"0")}-${String(defaultStart.getDate()).padStart(2,"0")}`;

  function validateDates(start, end) {
    if (!start || !end) return "Veuillez renseigner les deux dates.";
    if (start < "2019-01-01") return "La date de début doit être égale ou postérieure au 01/01/2019.";
    if (end > todayIso) return "La date de fin ne peut pas dépasser la date du jour.";
    if (start >= end) return "La date de début doit être antérieure à la date de fin.";
    const diff = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
    if (diff < 10) return "L'intervalle doit couvrir au moins 10 jours.";
    return "";
  }
  $("ndviForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("apiError").textContent = ""; $("dateError").textContent = ""; $("result").hidden = true;
    const start = $("startDate").value, end = $("endDate").value;
    const problem = validateDates(start, end);
    if (problem) { $("dateError").textContent = problem; return; }
    if (!num) { $("apiError").textContent = "Numéro de parcelle absent dans l'URL."; return; }
    const button = $("calculateButton"); button.disabled = true;
    $("loading").hidden = false;
    try {
      const response = await fetch("/api/ndvi", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num_parcelle: num, debut: start, fin: end })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
      $("ndviValue").textContent = Number(data.ndvi_moyen).toFixed(3);
      $("imageCount").textContent = String(data.nb_images);
      $("ndviInterpretation").textContent = data.interpretation;
      $("result").hidden = false;

      // Transmettre le résultat à la carte parente pour colorer le polygone.
      // Le message reste limité à la même origine que l'application.
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: "agriparcelles:ndvi-result",
          payload: {
            num_parcelle: data.num_parcelle || num,
            ndvi_moyen: Number(data.ndvi_moyen),
            debut: data.debut || start,
            fin: data.fin || end,
            nb_images: Number(data.nb_images),
            interpretation: data.interpretation || ""
          }
        }, window.location.origin);
      }
    } catch (error) {
      $("apiError").textContent = error.message;
    } finally {
      $("loading").hidden = true; button.disabled = false;
    }
  });
})();
