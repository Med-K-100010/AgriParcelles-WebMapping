(() => {
  "use strict";
  const MOROCCO_VIEW = { center: [31.8, -7.1], zoom: 6 };
  const STUDY = { lat: 30.40, lon: -9.21, radius: 10000 };
  const $ = (id) => document.getElementById(id);
  // Dernier NDVI calculé pour chaque parcelle, conservé pendant la session de la carte.
  const ndviByParcel = new Map();

  function classifyNdvi(value) {
    if (value < 0.2) return { color: "#b94b45", label: "Sol nu / végétation très faible", range: "NDVI < 0,2" };
    if (value < 0.4) return { color: "#e69a3b", label: "Végétation faible", range: "0,2 à < 0,4" };
    if (value <= 0.6) return { color: "#e5cf45", label: "Végétation modérée", range: "0,4 à 0,6" };
    return { color: "#32965a", label: "Végétation dense", range: "NDVI > 0,6" };
  }

  function parcelStyle(numParcel, selected = false) {
    const result = ndviByParcel.get(String(numParcel));
    const fillColor = result ? classifyNdvi(result.ndvi_moyen).color : "#f2c500";
    return {
      color: selected ? "#00bfe8" : (result ? "#30443a" : "#ffd600"),
      weight: selected ? 4 : 2.2,
      opacity: 1,
      fillColor,
      fillOpacity: result ? 0.62 : 0.20
    };
  }

  const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(MOROCCO_VIEW.center, MOROCCO_VIEW.zoom);

  // Panneau latéral rétractable : la carte reste en plein écran.
  const sidebar = $("sidebarPanel");
  const sidebarToggle = $("btnSidebarToggle");
  let sidebarCollapsed = false;

  function updateSidebarToggle() {
    document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
    sidebar.inert = sidebarCollapsed;
    sidebar.setAttribute("aria-hidden", String(sidebarCollapsed));
    sidebarToggle.setAttribute("aria-expanded", String(!sidebarCollapsed));
    sidebarToggle.setAttribute(
      "aria-label", sidebarCollapsed ? "Afficher le panneau latéral" : "Masquer le panneau latéral"
    );
    sidebarToggle.title = sidebarCollapsed ? "Afficher le panneau latéral" : "Masquer le panneau latéral";
    sidebarToggle.innerHTML = sidebarCollapsed
      ? '<span aria-hidden="true">☰</span>'
      : '<span aria-hidden="true">‹</span>';
  }

  function mapLeftPadding() {
    return sidebarCollapsed ? 24 : Math.min(365, Math.round(window.innerWidth * 0.30));
  }

  sidebarToggle.addEventListener("click", () => {
    sidebarCollapsed = !sidebarCollapsed;
    updateSidebarToggle();
  });

  sidebar.addEventListener("transitionend", (event) => {
    if (event.propertyName === "transform") map.invalidateSize({ pan: false });
  });

  window.addEventListener("resize", () => map.invalidateSize({ pan: false }));
  updateSidebarToggle();

  const terrain = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, subdomains: "abc",
    attribution: 'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, SRTM | Map style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  });
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a> — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  });
  terrain.addTo(map);

  const parcels = L.geoJSON(null, {
    style: (feature) => parcelStyle(feature && feature.properties ? feature.properties.num_parcelle : ""),
    onEachFeature: (feature, layer) => layer.on("click", () => onParcelClick(feature, layer))
  }).addTo(map);
  const studyCircle = L.circle([STUDY.lat, STUDY.lon], {
    radius: STUDY.radius, color: "#176b4b", weight: 2, dashArray: "7 6",
    fillColor: "#43a66d", fillOpacity: 0.035
  });
  const studyMarker = L.marker([STUDY.lat, STUDY.lon], {
    title: "Point de référence Z5 — Ouled Teïma"
  }).bindTooltip("Z5 · Ouled Teïma (−9,21 ; 30,40)");
  const zoneGuide = L.layerGroup([studyCircle, studyMarker]).addTo(map);
  L.control.layers(
    { "Terrain — OpenTopoMap": terrain, "Satellite — Esri World Imagery": satellite },
    { "Parcelles agricoles": parcels, "Zone de référence (rayon 10 km)": zoneGuide },
    { collapsed: true }
  ).addTo(map);
  L.control.scale({ metric: true, imperial: false, maxWidth: 140 }).addTo(map);

  // Légende de classification NDVI : elle apparaît au premier calcul réussi.
  const ndviLegend = L.control({ position: "bottomright" });
  ndviLegend.onAdd = function () {
    const div = L.DomUtil.create("div", "ndvi-map-legend");
    div.innerHTML = `
      <h4>NDVI moyen par parcelle</h4>
      <div class="ndvi-legend-item"><span class="ndvi-swatch" style="background:#b94b45"></span><span><strong>&lt; 0,2</strong> — Sol nu / très faible</span></div>
      <div class="ndvi-legend-item"><span class="ndvi-swatch" style="background:#e69a3b"></span><span><strong>0,2 à &lt; 0,4</strong> — Faible</span></div>
      <div class="ndvi-legend-item"><span class="ndvi-swatch" style="background:#e5cf45"></span><span><strong>0,4 à 0,6</strong> — Modérée</span></div>
      <div class="ndvi-legend-item"><span class="ndvi-swatch" style="background:#32965a"></span><span><strong>&gt; 0,6</strong> — Dense</span></div>
      <p class="ndvi-legend-note">La couleur représente la moyenne de la parcelle pour la période calculée.</p>`;
    div.hidden = true;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  ndviLegend.addTo(map);

  let drawingLayer = null;
  let selectionMode = false;
  let selectedLayer = null;
  let toastTimer = null;
  let lastAreaReady = false;
  let parcelFeatures = [];
  let focusedParcelIndex = -1;

  function showToast(message, duration = 3600) {
    const box = $("toast"); box.textContent = message; box.classList.add("show");
    window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => box.classList.remove("show"), duration);
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function getParcelLayerByNumber(numParcel) {
    let found = null;
    parcels.eachLayer((layer) => {
      const properties = layer.feature && layer.feature.properties;
      if (properties && String(properties.num_parcelle) === String(numParcel)) found = layer;
    });
    return found;
  }

  function applyNdviResult(payload) {
    const num = String(payload.num_parcelle || "").trim();
    const value = Number(payload.ndvi_moyen);
    if (!num || !Number.isFinite(value) || value < -1 || value > 1) {
      showToast("Résultat NDVI reçu mais invalide : la parcelle n'a pas été recolorée.", 5000);
      return;
    }

    const result = {
      ndvi_moyen: value,
      debut: String(payload.debut || ""),
      fin: String(payload.fin || ""),
      nb_images: Number(payload.nb_images) || 0,
      interpretation: String(payload.interpretation || classifyNdvi(value).label)
    };
    ndviByParcel.set(num, result);

    const targetLayer = getParcelLayerByNumber(num);
    if (targetLayer) {
      targetLayer.setStyle(parcelStyle(num, targetLayer === selectedLayer));
      if (targetLayer.feature && targetLayer.feature.properties) {
        targetLayer.bindPopup(popupHtml(targetLayer.feature.properties), { maxWidth: 300 });
      }
    }

    if (ndviLegend.getContainer()) ndviLegend.getContainer().hidden = false;
    const category = classifyNdvi(value);
    showToast(`Parcelle ${num} colorée : NDVI ${value.toFixed(3)} — ${category.label}.`, 5200);
  }

  function popupHtml(p) {
    const rows = [
      ["Identifiant", p.id], ["Agriculteur", p.agriculteur], ["Culture", p.culture],
      ["Superficie", `${Number(p.superficie_ha).toFixed(4)} ha`], ["Production", `${Number(p.production_t).toFixed(2)} t`], ["Date de saisie", p.date_saisie]
    ];
    const ndvi = ndviByParcel.get(String(p.num_parcelle));
    if (ndvi) {
      rows.push(["NDVI moyen", ndvi.ndvi_moyen.toFixed(3)]);
      rows.push(["État de végétation", ndvi.interpretation]);
      if (ndvi.debut && ndvi.fin) rows.push(["Période NDVI", `${ndvi.debut} au ${ndvi.fin}`]);
      if (ndvi.nb_images) rows.push(["Images Sentinel-2", ndvi.nb_images]);
    }
    return `<div class="parcel-popup"><h4>Parcelle ${escapeHtml(p.num_parcelle)}</h4><table>${rows.map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`).join("")}</table><button type="button" class="btn btn-danger btn-popup-delete" data-delete-parcel="true" data-parcel-id="${Number(p.id)}" data-parcel-number="${escapeHtml(p.num_parcelle)}">Supprimer cette parcelle</button></div>`;
  }
  async function loadParcelles() {
    try {
      const response = await fetch("/api/parcelles");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "API indisponible");
      parcelFeatures = Array.isArray(data.features) ? data.features : [];
      parcels.clearLayers(); parcels.addData(data);
      // Réappliquer les styles NDVI connus après rechargement de la couche.
      parcels.eachLayer((layer) => {
        const p = layer.feature && layer.feature.properties;
        if (p && ndviByParcel.has(String(p.num_parcelle))) {
          layer.setStyle(parcelStyle(p.num_parcelle, layer === selectedLayer));
        }
      });
      updateParcelNavigator();
      $("parcelCount").textContent = `${data.count} / 15`;
      $("parcelProgress").style.width = `${Math.min(100, data.count / 15 * 100)}%`;
      if (data.count >= 15) showToast("Objectif de 15 parcelles atteint. Vérifiez les attributs et la provenance des relevés.");
      else if (data.count === 0) $("drawStatus").textContent = "La base ne contient pas encore de parcelle. Digitalisez les parcelles réelles visibles sur le satellite.";
      $("apiStatus").textContent = "API et base spatiale connectées";
      $("apiStatus").previousElementSibling.classList.add("ok");
    } catch (error) {
      $("apiStatus").textContent = "Serveur / SpatiaLite indisponible";
      showToast(error.message, 5000);
    }
  }
  function setSatellite() {
    if (!map.hasLayer(satellite)) map.addLayer(satellite);
    if (map.hasLayer(terrain)) map.removeLayer(terrain);
  }
  function updateParcelToggleButton() {
    const visible = map.hasLayer(parcels);
    $("btnToggleParcels").textContent = visible ? "Masquer les parcelles" : "Afficher les parcelles";
    $("btnToggleParcels").setAttribute("aria-pressed", visible ? "true" : "false");
  }
  function updateParcelNavigator() {
    const select = $("parcelNavigator");
    const previousValue = select.value;
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = parcelFeatures.length ? "Choisir une parcelle…" : "Aucune parcelle enregistrée";
    select.appendChild(placeholder);

    parcelFeatures.forEach((feature, index) => {
      const properties = feature.properties || {};
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${properties.num_parcelle || `Parcelle ${index + 1}`} — ${properties.culture || "Culture non précisée"}`;
      select.appendChild(option);
    });

    if (previousValue !== "" && Number(previousValue) < parcelFeatures.length) {
      select.value = previousValue;
      focusedParcelIndex = Number(previousValue);
    } else {
      select.value = "";
      focusedParcelIndex = -1;
    }
    $("btnFocusParcel").disabled = parcelFeatures.length === 0;
    $("btnDeleteParcel").disabled = select.value === "" || parcelFeatures.length === 0;
    $("btnPrevParcel").disabled = parcelFeatures.length < 2;
    $("btnNextParcel").disabled = parcelFeatures.length < 2;
    updateParcelToggleButton();
  }
  function focusParcel(index) {
    if (!Number.isInteger(index) || index < 0 || index >= parcelFeatures.length) {
      showToast("Aucune parcelle à localiser. Digitalisez d'abord une parcelle.");
      return;
    }
    const feature = parcelFeatures[index];
    const properties = feature.properties || {};
    focusedParcelIndex = index;
    $("parcelNavigator").value = String(index);
    $("btnDeleteParcel").disabled = false;

    // Rendre la couche visible même si elle a été masquée dans le contrôle des couches.
    if (!map.hasLayer(parcels)) parcels.addTo(map);
    updateParcelToggleButton();
    setSatellite();

    let targetLayer = null;
    parcels.eachLayer((layer) => {
      const layerId = layer.feature && layer.feature.properties && layer.feature.properties.id;
      if (String(layerId) === String(properties.id)) targetLayer = layer;
    });
    const bounds = targetLayer ? targetLayer.getBounds() : L.geoJSON(feature).getBounds();
    if (bounds && bounds.isValid()) {
      map.flyToBounds(bounds, {
        paddingTopLeft: [mapLeftPadding(), 35],
        paddingBottomRight: [30, 35], maxZoom: 17, duration: 0.8
      });
    }
    if (targetLayer) targetLayer.bindPopup(popupHtml(properties)).openPopup();
    showToast(`Parcelle ${properties.num_parcelle || index + 1} localisée.`);
  }
  function moveParcelSelection(direction) {
    const count = parcelFeatures.length;
    if (!count) return;
    const selectedValue = $("parcelNavigator").value;
    const current = selectedValue === "" ? focusedParcelIndex : Number(selectedValue);
    const base = Number.isInteger(current) && current >= 0 ? current : (direction > 0 ? -1 : 0);
    focusParcel((base + direction + count) % count);
  }
  async function deleteParcel(parcelId, parcelNumber) {
    const id = Number(parcelId);
    const number = String(parcelNumber || "cette parcelle");
    if (!Number.isInteger(id) || id <= 0) {
      showToast("Identifiant de parcelle invalide : suppression annulée.", 5000);
      return;
    }

    const confirmed = window.confirm(
      `Voulez-vous vraiment supprimer définitivement la parcelle ${number} ?\n\n` +
      "Cette action supprimera ses attributs et sa géométrie de la base de données. Elle ne peut pas être annulée."
    );
    if (!confirmed) return;

    try {
      const response = await fetch(`/api/parcelles/${id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);

      if (selectedLayer && selectedLayer.feature &&
          Number(selectedLayer.feature.properties.id) === id) {
        closeNdvi();
      }
      ndviByParcel.delete(number);
      map.closePopup();
      focusedParcelIndex = -1;
      $("parcelNavigator").value = "";
      await loadParcelles();
      $("drawStatus").textContent = `La parcelle ${number} a été supprimée. Vous pouvez poursuivre la gestion des parcelles.`;
      showToast(`Parcelle ${number} supprimée de la base de données.` , 5000);
    } catch (error) {
      showToast(`Suppression impossible : ${error.message}`, 6000);
    }
  }

  function onParcelClick(feature, layer) {
    const p = feature.properties || {};
    if (selectionMode) {
      if (selectedLayer) {
        const previousNumber = selectedLayer.feature && selectedLayer.feature.properties && selectedLayer.feature.properties.num_parcelle;
        selectedLayer.setStyle(parcelStyle(previousNumber, false));
      }
      selectedLayer = layer;
      selectedLayer.setStyle(parcelStyle(p.num_parcelle, true));
      const selectedIndex = parcelFeatures.findIndex((item) =>
        Number(item.properties && item.properties.id) === Number(p.id)
      );
      if (selectedIndex >= 0) {
        focusedParcelIndex = selectedIndex;
        $("parcelNavigator").value = String(selectedIndex);
        $("btnDeleteParcel").disabled = false;
      }
      selectionMode = false;
      document.body.classList.remove("selection-mode");
      $("btnSelectParcel").classList.remove("is-active");
      $("btnSelectParcel").textContent = "◎ Sélectionner une parcelle";
      openNdvi(p.num_parcelle);
    } else {
      const index = parcelFeatures.findIndex((item) =>
        Number(item.properties && item.properties.id) === Number(p.id)
      );
      if (index >= 0) {
        focusedParcelIndex = index;
        $("parcelNavigator").value = String(index);
        $("btnDeleteParcel").disabled = false;
      }
      layer.bindPopup(popupHtml(p), { maxWidth: 300 }).openPopup();
    }
  }
  function openNdvi(number) {
    $("ndviPanelTitle").textContent = `NDVI — ${number}`;
    $("ndviFrame").src = `/ndvi?num=${encodeURIComponent(number)}`;
    $("ndviPanel").hidden = false;
  }
  function closeNdvi() {
    $("ndviPanel").hidden = true;
    $("ndviFrame").src = "about:blank";
    if (selectedLayer) {
      const num = selectedLayer.feature && selectedLayer.feature.properties && selectedLayer.feature.properties.num_parcelle;
      selectedLayer.setStyle(parcelStyle(num, false));
    }
    selectedLayer = null;
  }
  function enableSelection() {
    selectionMode = !selectionMode;
    document.body.classList.toggle("selection-mode", selectionMode);
    $("btnSelectParcel").classList.toggle("is-active", selectionMode);
    $("btnSelectParcel").textContent = selectionMode ? "Mode sélection actif — cliquez une parcelle" : "◎ Sélectionner une parcelle";
    if (selectionMode) showToast("Cliquez sur le polygone de la parcelle à analyser.");
  }
  function cancelDrawing(remove = true) {
    if (map.pm) map.pm.disableDraw();
    if (remove && drawingLayer) drawingLayer.remove();
    drawingLayer = null; lastAreaReady = false;
    $("parcelModal").hidden = true;
    $("btnCancelDrawing").disabled = true;
    $("btnNewParcel").disabled = false;
    $("drawStatus").textContent = "Dessin annulé. Vous pouvez tracer une autre parcelle.";
  }
  function startDrawing() {
    if (!map.pm) { showToast("Leaflet-Geoman n'a pas été chargé. Vérifiez la connexion Internet.", 5000); return; }
    if (drawingLayer) cancelDrawing(true);
    setSatellite();
    map.pm.enableDraw("Polygon", {
      snappable: true, snapDistance: 18, allowSelfIntersection: false,
      continueDrawing: false, templineStyle: { color: "#ffd600", weight: 2 },
      hintlineStyle: { color: "#ffd600", dashArray: "5 5" },
      pathOptions: { color: "#ffd600", weight: 2.5, fillColor: "#f2c500", fillOpacity: 0.24 }
    });
    $("btnNewParcel").disabled = true;
    $("btnCancelDrawing").disabled = false;
    $("drawStatus").textContent = "Tracez le contour de la parcelle, puis double-cliquez pour terminer.";
  }
  async function onPolygonCreated(event) {
    if (event.shape !== "Polygon") { event.layer.remove(); return; }
    if (drawingLayer) drawingLayer.remove();
    drawingLayer = event.layer;
    map.pm.disableDraw();
    drawingLayer.setStyle({ color: "#ff9f1c", weight: 2.5, dashArray: "6 4", fillOpacity: 0.22 });
    $("parcelModal").hidden = false;
    $("parcelFormError").textContent = "";
    $("areaHa").value = "Calcul en cours…";
    $("btnSaveParcel").disabled = false;
    lastAreaReady = false;
    $("drawStatus").textContent = "Polygone terminé : renseignez les attributs et enregistrez.";
    try {
      const response = await fetch("/api/geometry/area", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geometry: drawingLayer.toGeoJSON().geometry })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Géométrie invalide");
      $("areaHa").value = Number(data.superficie_ha).toFixed(4);
      lastAreaReady = true;
    } catch (error) {
      $("areaHa").value = "À recalculer à l'enregistrement";
      $("parcelFormError").textContent = error.message;
    }
    $("parcelNumber").focus();
  }

  $("btnMorocco").addEventListener("click", () => {
    map.flyTo(MOROCCO_VIEW.center, MOROCCO_VIEW.zoom, { duration: 0.8 });
  });
  $("btnStudyArea").addEventListener("click", () => {
    try {
      setSatellite();
      if (!map.hasLayer(zoneGuide)) zoneGuide.addTo(map);
      map.invalidateSize({ pan: false });
      map.flyToBounds(studyCircle.getBounds(), {
        paddingTopLeft: [mapLeftPadding(), 35],
        paddingBottomRight: [30, 35], maxZoom: 13, duration: 1.0
      });
      showToast("Zone d'étude Z5 affichée : cercle de référence de 10 km autour d'Ouled Teïma.");
    } catch (error) {
      console.error("Impossible d'afficher la zone d'étude :", error);
      showToast("Impossible de cadrer la zone d'étude. Consultez la console du navigateur.", 5000);
    }
  });
  $("btnToggleParcels").addEventListener("click", () => {
    if (map.hasLayer(parcels)) map.removeLayer(parcels);
    else parcels.addTo(map);
    updateParcelToggleButton();
  });
  $("parcelNavigator").addEventListener("change", () => {
    const value = $("parcelNavigator").value;
    if (value !== "") focusParcel(Number(value));
  });
  $("btnFocusParcel").addEventListener("click", () => {
    const value = $("parcelNavigator").value;
    if (value === "") { showToast("Choisissez d'abord une parcelle dans la liste."); return; }
    focusParcel(Number(value));
  });
  $("btnPrevParcel").addEventListener("click", () => moveParcelSelection(-1));
  $("btnNextParcel").addEventListener("click", () => moveParcelSelection(1));
  $("btnDeleteParcel").addEventListener("click", () => {
    const value = $("parcelNavigator").value;
    const index = value === "" ? focusedParcelIndex : Number(value);
    const feature = Number.isInteger(index) && index >= 0 ? parcelFeatures[index] : null;
    if (!feature || !feature.properties) {
      showToast("Choisissez d'abord une parcelle dans la liste ou sur la carte.");
      return;
    }
    deleteParcel(feature.properties.id, feature.properties.num_parcelle);
  });
  map.on("popupopen", (event) => {
    const popupButton = event.popup.getElement()?.querySelector("[data-delete-parcel='true']");
    if (!popupButton) return;
    popupButton.addEventListener("click", () => {
      deleteParcel(popupButton.dataset.parcelId, popupButton.dataset.parcelNumber);
    }, { once: true });
  });
  map.on("overlayadd overlayremove", (event) => {
    if (event.layer === parcels) updateParcelToggleButton();
  });
  $("btnGoCoordinates").addEventListener("click", () => {
    const xRaw = $("longitude").value.trim(), yRaw = $("latitude").value.trim();
    const x = Number(xRaw), y = Number(yRaw);
    let message = "";
    if (!xRaw || !yRaw || !Number.isFinite(x) || !Number.isFinite(y)) message = "Saisissez deux coordonnées numériques valides.";
    else if (x < -17.5 || x > -0.9) message = "Longitude X hors emprise : la valeur doit être comprise entre −17,5 et −0,9.";
    else if (y < 20.5 || y > 36.1) message = "Latitude Y hors emprise : la valeur doit être comprise entre 20,5 et 36,1.";
    $("coordinateError").textContent = message;
    if (message) return;
    setSatellite(); map.setView([y, x], 17);
    if (window.coordinateMarker) map.removeLayer(window.coordinateMarker);
    window.coordinateMarker = L.marker([y, x]).addTo(map).bindPopup(`Point WGS84<br>Longitude X : ${x.toFixed(5)}<br>Latitude Y : ${y.toFixed(5)}`).openPopup();
  });
  $("btnNewParcel").addEventListener("click", startDrawing);
  $("btnCancelDrawing").addEventListener("click", () => cancelDrawing(true));
  $("btnDiscardParcel").addEventListener("click", () => cancelDrawing(true));
  $("btnCloseModal").addEventListener("click", () => cancelDrawing(true));
  $("parcelModal").addEventListener("click", (event) => { if (event.target === $("parcelModal")) cancelDrawing(true); });
  $("btnSelectParcel").addEventListener("click", enableSelection);
  $("btnCloseNdvi").addEventListener("click", closeNdvi);

  // Réception du résultat de calcul envoyé par l'iframe NDVI (même origine uniquement).
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== $("ndviFrame").contentWindow) return;
    if (!event.data || event.data.type !== "agriparcelles:ndvi-result") return;
    applyNdviResult(event.data.payload || {});
  });

  map.on("pm:create", onPolygonCreated);
  map.on("mousemove", (event) => {
    $("mouseCoordinates").textContent = `Lat ${event.latlng.lat.toFixed(5)}°  ·  Lon ${event.latlng.lng.toFixed(5)}°`;
  });

  $("parcelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!drawingLayer) { $("parcelFormError").textContent = "Aucun polygone à enregistrer."; return; }
    const productionText = $("production").value;
    const production = Number(productionText);
    if (!productionText || !Number.isFinite(production) || production < 0) {
      $("parcelFormError").textContent = "La production doit être un nombre positif ou nul."; return;
    }
    const payload = {
      num_parcelle: $("parcelNumber").value.trim(),
      agriculteur: $("farmerName").value.trim(),
      culture: $("crop").value,
      production_t: production,
      geometry: drawingLayer.toGeoJSON().geometry
    };
    if (!payload.num_parcelle || !payload.agriculteur || !payload.culture) {
      $("parcelFormError").textContent = "Tous les champs obligatoires doivent être renseignés."; return;
    }
    const button = $("btnSaveParcel"); button.disabled = true; button.textContent = "Enregistrement…";
    $("parcelFormError").textContent = "";
    try {
      const response = await fetch("/api/parcelles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) {
        // Le polygone n'est pas supprimé : un HTTP 409 doit laisser corriger le numéro.
        throw new Error(data.error || `Erreur HTTP ${response.status}`);
      }
      drawingLayer.remove(); drawingLayer = null; $("parcelModal").hidden = true;
      $("parcelForm").reset(); $("btnCancelDrawing").disabled = true; $("btnNewParcel").disabled = false;
      $("drawStatus").textContent = `Parcelle ${data.properties.num_parcelle} enregistrée.`;
      await loadParcelles();
      showToast(`Parcelle ${data.properties.num_parcelle} enregistrée (${Number(data.properties.superficie_ha).toFixed(4)} ha).`);
    } catch (error) {
      $("parcelFormError").textContent = error.message;
    } finally {
      button.disabled = false; button.textContent = "Enregistrer la parcelle";
    }
  });

  // Déplacement de la fenêtre NDVI par sa barre supérieure, sans bibliothèque supplémentaire.
  const dragHandle = $("ndviDragHandle"), panel = $("ndviPanel");
  let drag = null;
  dragHandle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    dragHandle.setPointerCapture(event.pointerId);
    $("ndviFrame").style.pointerEvents = "none";
  });
  dragHandle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, drag.left + event.clientX - drag.x));
    const top = Math.max(0, Math.min(window.innerHeight - 90, drag.top + event.clientY - drag.y));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`; panel.style.right = "auto";
  });
  const stopDrag = () => { drag = null; $("ndviFrame").style.pointerEvents = "auto"; };
  dragHandle.addEventListener("pointerup", stopDrag); dragHandle.addEventListener("pointercancel", stopDrag);

  fetch("/api/health").then((r) => { if (!r.ok) throw new Error("API indisponible"); return r.json(); })
    .then(() => loadParcelles())
    .catch(() => { $("apiStatus").textContent = "Initialisez la base puis démarrez le serveur"; showToast("Base SpatiaLite non initialisée ou extension introuvable. Consultez le journal d'installation.", 6000); });
})();
