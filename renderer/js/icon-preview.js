const previewGroups = [
  {
    title: "Workspace navigation",
    icons: [
      ["house", "Dashboard"], ["file-spreadsheet", "SOA generator"], ["workflow", "Automation"],
      ["file-pen-line", "Edit claims"], ["play", "Run workflow"], ["wrench", "Other tools"],
      ["messages-square", "Team chat"], ["settings", "Settings"], ["users-round", "User management"],
      ["info", "About"], ["mail", "Contact"],
    ],
  },
  {
    title: "Tools and documents",
    icons: [
      ["file-text", "PDF auto rename"], ["files", "Documents"], ["scissors", "PDF splitter"],
      ["file-pen-line", "PDF editor"], ["calendar-days", "DTR generator"], ["file-up", "Upload"],
      ["clipboard-list", "Claim forms"], ["file-check-2", "Review claims"], ["folder-open", "Open files"],
    ],
  },
  {
    title: "Header and actions",
    icons: [
      ["search", "Search"], ["heart-pulse", "Beacon heartbeat"], ["bell", "Notifications"],
      ["user-round", "Account"], ["log-out", "Sign out"], ["circle-help", "Help"],
      ["arrow-up-right", "Open external page"], ["plus", "Add"], ["check", "Confirm"],
      ["menu", "Open menu"], ["x", "Close"], ["sun", "Light theme"], ["moon", "Dark theme"],
      ["chevron-left", "Collapse sidebar"], ["chevron-right", "Expand sidebar"],
      ["chevron-down", "Expand submenu"], ["panel-left-close", "Collapse navigation"],
      ["panel-left-open", "Expand navigation"], ["activity", "Activity status"], ["circle-alert", "Warning"],
    ],
  },
];

const groupsRoot = document.getElementById("iconPreviewGroups");
const filterInput = document.getElementById("iconFilter");
const countLabel = document.getElementById("iconCount");
const emptyState = document.getElementById("iconEmptyState");
const themeToggle = document.getElementById("previewThemeToggle");

function iconCard([name, use], category) {
  const card = document.createElement("article");
  card.className = "icon-card";
  card.dataset.filter = `${name} ${use} ${category}`.toLocaleLowerCase();

  const head = document.createElement("div");
  head.className = "icon-card-head";
  const iconBox = document.createElement("span");
  iconBox.className = "icon-preview";
  iconBox.append(BeabotsIcons.create(name, { size: 20, strokeWidth: 1.9 }));

  const title = document.createElement("span");
  title.className = "icon-title";
  const strong = document.createElement("strong");
  strong.textContent = name;
  const small = document.createElement("small");
  small.textContent = use;
  title.append(strong, small);
  head.append(iconBox, title);

  const sizes = document.createElement("div");
  sizes.className = "icon-sizes";
  [[20, "Sidebar"], [16, "Button"]].forEach(([size, label]) => {
    const sample = document.createElement("span");
    sample.className = "size-sample";
    sample.append(BeabotsIcons.create(name, { size, strokeWidth: 1.9 }), document.createTextNode(`${label} - ${size}px`));
    sizes.append(sample);
  });
  card.append(head, sizes);
  return card;
}

previewGroups.forEach((group) => {
  const section = document.createElement("section");
  section.className = "preview-section";
  const heading = document.createElement("h2");
  heading.textContent = group.title;
  const grid = document.createElement("div");
  grid.className = "icon-grid";
  group.icons.forEach((icon) => grid.append(iconCard(icon, group.title)));
  section.append(heading, grid);
  groupsRoot.append(section);
});

function filterIcons() {
  const query = filterInput.value.trim().toLocaleLowerCase();
  let visible = 0;
  document.querySelectorAll(".icon-card").forEach((card) => {
    card.hidden = Boolean(query) && !card.dataset.filter.includes(query);
    if (!card.hidden) visible += 1;
  });
  document.querySelectorAll(".preview-section").forEach((section) => {
    section.hidden = !section.querySelector(".icon-card:not([hidden])");
  });
  countLabel.textContent = `${visible} icons`;
  emptyState.hidden = visible > 0;
}

function updateThemeControl() {
  const light = document.documentElement.dataset.theme === "light";
  themeToggle.replaceChildren(BeabotsIcons.create(light ? "moon" : "sun", { size: 16 }));
  themeToggle.setAttribute("aria-label", `Switch to ${light ? "dark" : "light"} theme`);
}

document.getElementById("backIcon").append(BeabotsIcons.create("arrow-left", { size: 16 }));
filterInput.addEventListener("input", filterIcons);
themeToggle.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  window.beabotsTheme?.setTheme(theme);
  updateThemeControl();
});

filterIcons();
updateThemeControl();
