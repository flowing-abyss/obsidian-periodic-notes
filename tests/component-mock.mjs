// Only native view ownership is tested here. Svelte rendering is verified in
// Obsidian itself, with the actual components and the installed host API.
export default class ComponentMock {
  static instances = [];
  constructor({ target }) {
    this.$$ = { root: target };
    this.destroyCount = 0;
    ComponentMock.instances.push(this);
  }
  $destroy() { this.destroyCount++; }
}
