if (window.parent && window.parent !== window) {
  document.body.classList.add("embedded-page");
}

function syncAboutNavigation() {
  const current = window.location.hash.slice(1) || "about";
  document.querySelectorAll(".about-nav a[data-section]").forEach((link) => {
    const active = link.dataset.section === current;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

window.addEventListener("hashchange", syncAboutNavigation);
syncAboutNavigation();
