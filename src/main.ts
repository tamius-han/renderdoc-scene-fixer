import './main.css';
import { SceneViewerApp } from "./app";

const viewport = document.getElementById("viewport");
if (!viewport) throw new Error("Missing #viewport element");

new SceneViewerApp(viewport);
