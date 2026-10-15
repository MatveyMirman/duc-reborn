import {
	BrowserRouter,
	Navigate,
	Route,
	Routes,
	useLocation,
} from "react-router-dom";
import Dashboard from "./components/Dashboard";
import History from "./components/History";
import Layout from "./components/Layout";
import Login from "./components/Login";
import { Toasts } from "./components/Toast";
import { useAuthStore } from "./stores/authStore";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
	const { isAuthenticated, credentialsRequired } = useAuthStore();
	const location = useLocation();
	if (!isAuthenticated) {
		const to = credentialsRequired ? "/login" : "/";
		return (
			<Navigate
				to={to}
				state={{ from: location.pathname + location.search + location.hash }}
				replace
			/>
		);
	}
	return <>{children}</>;
}

function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/login" element={<Login />} />
				<Route
					path="/"
					element={
						<ProtectedRoute>
							<Layout />
						</ProtectedRoute>
					}
				>
					<Route index element={<Dashboard />} />
					<Route path="history" element={<History />} />
				</Route>
			</Routes>
			<Toasts />
		</BrowserRouter>
	);
}

export default App;
