import './main.css';
import { SceneViewerApp } from "./app";
import { registerWebComponents } from "./components/wcmodule";

registerWebComponents();
const viewport = document.getElementById("viewport");
if (!viewport) throw new Error("Missing #viewport element");

new SceneViewerApp(viewport);
